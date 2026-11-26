import type { NetworkAccessDecision, TenantVmRecord } from "../../shared/isolation.ts";

export interface NetworkPolicyConfig {
  controlPlanePublicHost: string;
  controlPlanePublicPort: number;
  egressProxyHost: string;
  egressProxyPort: number;
  controlPlanePublicPrefixes: string[];
}

export const DEFAULT_NETWORK_POLICY_CONFIG: NetworkPolicyConfig = {
  controlPlanePublicHost: "10.200.0.1",
  controlPlanePublicPort: 8799,
  egressProxyHost: "10.200.0.2",
  egressProxyPort: 3128,
  controlPlanePublicPrefixes: ["/api/isolation/vm/", "/api/memory-skill/retrieve", "/api/tickets/", "/api/approvals/"],
};

const BLOCKED_INTERNAL_PREFIXES = ["/internal/", "/api/admin/", "/api/isolation/admin/", "/metrics"];

/**
 * Evaluates outbound network access from a tenant microVM.
 * Enforces:
 * 1. VM-to-VM traffic is strictly denied (no lateral movement between tenant VMs).
 * 2. Loopback, cloud metadata (169.254.169.254), and control-plane internal endpoints are denied.
 * 3. Only declared control-plane public API endpoints and the egress proxy are allowed.
 */
export function evaluateVmNetworkAccess(input: {
  sourceVm: TenantVmRecord;
  allVms: TenantVmRecord[];
  targetAddress: string;
  targetPort: number;
  targetPath?: string;
  config?: NetworkPolicyConfig;
}): NetworkAccessDecision {
  const cfg = input.config ?? DEFAULT_NETWORK_POLICY_CONFIG;
  const targetAddress = input.targetAddress.trim();
  const targetPath = input.targetPath?.trim();

  // 1. Block lateral access to any other tenant's VM IP
  const peerVm = input.allVms.find((v) => v.tenantId !== input.sourceVm.tenantId && v.ipAddress === targetAddress);
  if (peerVm) {
    return {
      allowed: false,
      sourceTenantId: input.sourceVm.tenantId,
      sourceVmId: input.sourceVm.vmId,
      targetAddress,
      targetPort: input.targetPort,
      targetPath,
      reason: `cross_vm_network_blocked:${peerVm.vmId}`,
    };
  }

  // 2. Block loopback, link-local / cloud metadata, and arbitrary VM-subnet scanning
  if (
    targetAddress === "127.0.0.1" ||
    targetAddress === "::1" ||
    targetAddress === "localhost" ||
    targetAddress.startsWith("169.254.")
  ) {
    return {
      allowed: false,
      sourceTenantId: input.sourceVm.tenantId,
      sourceVmId: input.sourceVm.vmId,
      targetAddress,
      targetPort: input.targetPort,
      targetPath,
      reason: "control_plane_internal_or_metadata_blocked",
    };
  }

  // 3. Control plane endpoint check: only public allowlisted prefixes on public port are permitted
  if (targetAddress === cfg.controlPlanePublicHost && input.targetPort === cfg.controlPlanePublicPort) {
    if (targetPath && BLOCKED_INTERNAL_PREFIXES.some((prefix) => targetPath.startsWith(prefix))) {
      return {
        allowed: false,
        sourceTenantId: input.sourceVm.tenantId,
        sourceVmId: input.sourceVm.vmId,
        targetAddress,
        targetPort: input.targetPort,
        targetPath,
        reason: "control_plane_internal_endpoint_blocked",
      };
    }
    if (!targetPath || cfg.controlPlanePublicPrefixes.some((prefix) => targetPath.startsWith(prefix))) {
      return {
        allowed: true,
        sourceTenantId: input.sourceVm.tenantId,
        sourceVmId: input.sourceVm.vmId,
        targetAddress,
        targetPort: input.targetPort,
        targetPath,
        reason: "control_plane_public_api_allowed",
      };
    }
    return {
      allowed: false,
      sourceTenantId: input.sourceVm.tenantId,
      sourceVmId: input.sourceVm.vmId,
      targetAddress,
      targetPort: input.targetPort,
      targetPath,
      reason: "control_plane_path_not_allowlisted",
    };
  }

  // 4. Egress proxy check
  if (targetAddress === cfg.egressProxyHost && input.targetPort === cfg.egressProxyPort) {
    return {
      allowed: true,
      sourceTenantId: input.sourceVm.tenantId,
      sourceVmId: input.sourceVm.vmId,
      targetAddress,
      targetPort: input.targetPort,
      targetPath,
      reason: "egress_proxy_allowed",
    };
  }

  // 5. Default deny (covers subnet scans like 10.200.x.y and direct internet bypass)
  return {
    allowed: false,
    sourceTenantId: input.sourceVm.tenantId,
    sourceVmId: input.sourceVm.vmId,
    targetAddress,
    targetPort: input.targetPort,
    targetPath,
    reason: "default_deny_outbound_not_allowlisted",
  };
}
