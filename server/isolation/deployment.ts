import type {
  PrivateDeploymentSpec,
  PrivateDeploymentValidationResult,
} from "../../shared/isolation.ts";

const REQUIRED_NOTICES = ["LICENSE", "NOTICE", "third_party/cua-driver"] as const;

/**
 * Validates private deployment packaging and licensing compliance:
 * - Source code MUST NOT be distributed to private deployment customers.
 * - Core logic stays in vendor cloud control plane (worker connects back) OR compiled container image only.
 * - `enterprise/` MUST NOT be distributed without verified commercial license.
 * - Apache-2.0 `LICENSE`, `NOTICE`, and `third_party/cua-driver` notices MUST be preserved.
 */
export function validatePrivateDeploymentSpec(spec: PrivateDeploymentSpec): PrivateDeploymentValidationResult {
  const violations: string[] = [];

  if (spec.includesSourceCode) {
    violations.push("source_code_distribution_forbidden: 私有部署禁止交付项目源码，只允许 Worker 回连控制面或编译镜像");
  }

  if (spec.mode === "cloud_control_plane_worker") {
    if (!spec.controlPlaneCallbackUrl || !/^https?:\/\/.+/.test(spec.controlPlaneCallbackUrl)) {
      violations.push("missing_control_plane_callback_url: Worker 模式必须配置回连厂商云端控制平面的地址");
    }
  } else if (spec.mode === "compiled_image") {
    if (!spec.workerImageRef || !spec.workerImageRef.trim()) {
      violations.push("missing_compiled_image_ref: 编译镜像模式必须提供镜像引用");
    }
  }

  if (spec.includesEnterpriseDir && !spec.enterpriseCommercialLicenseVerified) {
    violations.push("unauthorized_enterprise_distribution: 未取得 Milind Soni 商业许可前禁止分发 enterprise/ 目录");
  }

  const preserved = new Set(spec.preservedNotices.map((n) => n.trim()));
  for (const notice of REQUIRED_NOTICES) {
    if (!preserved.has(notice)) {
      violations.push(`missing_required_license_notice:${notice}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    mode: spec.mode,
  };
}
