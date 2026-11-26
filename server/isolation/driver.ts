import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

import type { TenantVmRecord, VmDriverKind, VmQuota } from "../../shared/isolation.ts";

export interface FirecrackerVmConfig {
  "boot-source": { kernel_image_path: string; boot_args: string };
  drives: Array<{ drive_id: string; path_on_host: string; is_root_device: boolean; is_read_only: boolean }>;
  "machine-config": { vcpu_count: number; mem_size_mib: number; smt: boolean };
  "network-interfaces": Array<{ iface_id: string; guest_mac: string; host_dev_name: string }>;
}

/**
 * Unified microVM driver abstraction.
 * Production Linux KVM hosts use Firecracker; macOS/local isolated verification uses IsolatedLocalDriver
 * with real per-tenant persistent disk directories, tar.gz snapshots, and strict path confinement.
 */
export interface MicroVmDriver {
  readonly kind: VmDriverKind;
  provisionDisk(tenantId: string, vmId: string, quota: VmQuota): { diskPath: string; browserProfilePath: string };
  restartVm(vm: TenantVmRecord): { restartedAt: number; stateIntact: boolean };
  hibernateVm(vm: TenantVmRecord): { hibernatedAt: number; memoryReleasedMb: number };
  wakeVm(vm: TenantVmRecord): { wokenAt: number; wakeLatencyMs: number };
  createSnapshot(vm: TenantVmRecord, snapshotId: string): { archivePath: string; sha256: string; sizeBytes: number; backupMs: number };
  restoreSnapshot(archivePath: string, expectedSha256: string, targetDiskPath: string): { restoreMs: number };
  destroyDisk(diskPath: string): void;
  writeWorkspaceFile(vm: TenantVmRecord, relPath: string, content: string): string;
  readWorkspaceFile(vm: TenantVmRecord, relPath: string): string | null;
  listWorkspaceFiles(vm: TenantVmRecord): Record<string, string>;
  measureDiskBytes(diskPath: string): number;
}

function safeResolveInDisk(diskPath: string, relPath: string): string {
  const cleanRel = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const root = resolve(diskPath, "workspace");
  const target = resolve(root, cleanRel);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes("\0")) {
    throw new Error("path_traversal_blocked");
  }
  return target;
}

export class IsolatedLocalDriver implements MicroVmDriver {
  readonly kind: VmDriverKind = "isolated-local";
  private readonly rootDir: string;
  private readonly snapshotDir: string;

  constructor(baseDataDir: string) {
    this.rootDir = join(baseDataDir, "isolation-disks");
    this.snapshotDir = join(baseDataDir, "isolation-snapshots");
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.snapshotDir, { recursive: true });
  }

  provisionDisk(tenantId: string, vmId: string, quota: VmQuota): { diskPath: string; browserProfilePath: string } {
    const safeTenant = tenantId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const diskPath = join(this.rootDir, safeTenant);
    const workspacePath = join(diskPath, "workspace");
    const browserProfilePath = join(diskPath, "browser-profile");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(browserProfilePath, { recursive: true });
    const metaPath = join(diskPath, "vm-meta.json");
    if (!existsSync(metaPath)) {
      writeFileSync(
        metaPath,
        JSON.stringify({ tenantId, vmId, quota, bootLoadedFullMemory: false, createdAt: Date.now() }, null, 2),
      );
    }
    return { diskPath, browserProfilePath };
  }

  restartVm(vm: TenantVmRecord): { restartedAt: number; stateIntact: boolean } {
    const restartedAt = Date.now();
    const stateIntact = existsSync(join(vm.diskPath, "vm-meta.json")) && existsSync(join(vm.diskPath, "workspace"));
    if (stateIntact) {
      writeFileSync(join(vm.diskPath, "last-restart.json"), JSON.stringify({ vmId: vm.vmId, restartedAt }));
    }
    return { restartedAt, stateIntact };
  }

  hibernateVm(vm: TenantVmRecord): { hibernatedAt: number; memoryReleasedMb: number } {
    const hibernatedAt = Date.now();
    writeFileSync(join(vm.diskPath, "hibernation-state.json"), JSON.stringify({ vmId: vm.vmId, hibernatedAt }));
    return { hibernatedAt, memoryReleasedMb: vm.quota.memoryGb * 1024 };
  }

  wakeVm(vm: TenantVmRecord): { wokenAt: number; wakeLatencyMs: number } {
    const t0 = performance.now();
    const hibFile = join(vm.diskPath, "hibernation-state.json");
    if (existsSync(hibFile)) {
      rmSync(hibFile, { force: true });
    }
    const wakeLatencyMs = Math.max(1, Math.round(performance.now() - t0));
    return { wokenAt: Date.now(), wakeLatencyMs };
  }

  createSnapshot(vm: TenantVmRecord, snapshotId: string): { archivePath: string; sha256: string; sizeBytes: number; backupMs: number } {
    const archivePath = join(this.snapshotDir, `${snapshotId}.tar.gz`);
    const t0 = performance.now();
    execFileSync("tar", ["-czf", archivePath, "-C", vm.diskPath, "."]);
    const backupMs = Math.max(1, Math.round(performance.now() - t0));
    const buf = readFileSync(archivePath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return { archivePath, sha256, sizeBytes: buf.byteLength, backupMs };
  }

  restoreSnapshot(archivePath: string, expectedSha256: string, targetDiskPath: string): { restoreMs: number } {
    const buf = readFileSync(archivePath);
    const actualSha256 = createHash("sha256").update(buf).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error("snapshot_checksum_mismatch");
    }
    mkdirSync(targetDiskPath, { recursive: true });
    const t0 = performance.now();
    execFileSync("tar", ["-xzf", archivePath, "-C", targetDiskPath]);
    const restoreMs = Math.max(1, Math.round(performance.now() - t0));
    return { restoreMs };
  }

  destroyDisk(diskPath: string): void {
    if (existsSync(diskPath)) {
      rmSync(diskPath, { recursive: true, force: true });
    }
  }

  writeWorkspaceFile(vm: TenantVmRecord, relPath: string, content: string): string {
    const target = safeResolveInDisk(vm.diskPath, relPath);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
    return target;
  }

  readWorkspaceFile(vm: TenantVmRecord, relPath: string): string | null {
    const target = safeResolveInDisk(vm.diskPath, relPath);
    if (!existsSync(target)) return null;
    return readFileSync(target, "utf8");
  }

  listWorkspaceFiles(vm: TenantVmRecord): Record<string, string> {
    const root = resolve(vm.diskPath, "workspace");
    if (!existsSync(root)) return {};
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          out[relative(root, full)] = readFileSync(full, "utf8");
        }
      }
    };
    walk(root);
    return out;
  }

  measureDiskBytes(diskPath: string): number {
    if (!existsSync(diskPath)) return 0;
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += statSync(full).size;
      }
    };
    walk(diskPath);
    return total;
  }
}

/** Builds a Firecracker microVM machine configuration for Linux KVM hosts. */
export function buildFirecrackerConfig(vm: TenantVmRecord, kernelImagePath = "/var/lib/openmausbot/vmlinux"): FirecrackerVmConfig {
  const tapName = `tap-${vm.vmId.slice(-8)}`;
  const octets = vm.ipAddress.split(".").map((n) => Number(n).toString(16).padStart(2, "0"));
  return {
    "boot-source": {
      kernel_image_path: kernelImagePath,
      boot_args: `console=ttyS0 reboot=k panic=1 pci=off ip=${vm.ipAddress}`,
    },
    drives: [
      {
        drive_id: "rootfs",
        path_on_host: join(vm.diskPath, "rootfs.ext4"),
        is_root_device: true,
        is_read_only: false,
      },
    ],
    "machine-config": {
      vcpu_count: vm.quota.vcpu,
      mem_size_mib: vm.quota.memoryGb * 1024,
      smt: false,
    },
    "network-interfaces": [
      {
        iface_id: "eth0",
        guest_mac: `06:00:${octets[0] ?? "0a"}:${octets[1] ?? "c8"}:${octets[2] ?? "00"}:${octets[3] ?? "01"}`,
        host_dev_name: tapName,
      },
    ],
  };
}
