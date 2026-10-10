/** WANX management protocol v1. Server roles, never this type, authorize actions. */
export type ClientPlatform = "macos" | "windows";
export type ClientArchitecture = "arm64" | "x64";
export interface ApplicationResourceRequirement {
  readonly kind: "model" | "provider" | "storage" | "skill" | "plugin";
  readonly required?: boolean;
}
export interface ApplicationProfile { readonly application_id: string; readonly agent_id: string | null; }
export interface ProductDefinition {
  readonly application_id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly agent_template: Readonly<Record<string, unknown>>;
  readonly resource_requirements: Readonly<Record<string, ApplicationResourceRequirement>>;
}
export interface ConnectionIdentityRegistration {
  readonly status: "pending";
  readonly application_id: string;
  readonly remote_enabled: false;
}
export interface ApplicationProduct extends ProductDefinition {
  readonly created_by: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly connection_identity: ConnectionIdentityRegistration;
}
export interface DeploymentConfiguration {
  readonly enabled: boolean;
  readonly resource_bindings: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, unknown>>;
}
export interface ApplicationDeployment extends DeploymentConfiguration {
  readonly application_id: string;
  readonly updated_at: number;
}
export interface ClientReleaseInput {
  readonly version: string;
  readonly platform: ClientPlatform;
  readonly arch: ClientArchitecture;
  readonly url: string;
  readonly sha256: string;
  readonly min_wanx_version: string;
  readonly min_sdk_version: string;
  readonly recommended: boolean;
}
export interface ClientRelease extends ClientReleaseInput { readonly created_at: number; }
export interface ApplicationAccess { readonly user_id: number; readonly username: string; readonly enabled: boolean; readonly updated_at: number; }
export interface ApplicationManifest { readonly schema_version: 1; readonly product: ProductDefinition; readonly deployment: DeploymentConfiguration; }
export interface CompatibleRelease {
  readonly application_id: string;
  readonly current_version: string;
  readonly release: ClientRelease | null;
  readonly update_available: boolean;
}
export interface ReleaseQuery {
  readonly platform: ClientPlatform;
  readonly arch: ClientArchitecture;
  readonly current_version: string;
  readonly sdk_version?: string;
}
export interface ManagementCapabilities {
  readonly server_version: string;
  readonly sdk_management: { readonly protocol_version: 1; readonly applications: true; readonly remote_identity_registration: false };
  readonly permissions: readonly string[];
}
type ApplicationPath = { readonly application_id: string };
type Op<R, B> = { readonly request: R; readonly responseBody: B };
export interface ApplicationOperations {
  "wanxApplicationsGetProfile": Op<{ readonly path: ApplicationPath }, ApplicationProfile>;
  "wanxApplicationsCreateProfile": Op<{ readonly path: ApplicationPath }, ApplicationProfile>;
  "wanxApplicationsList": Op<{}, readonly ApplicationProduct[]>;
  "wanxApplicationsCreate": Op<{ readonly body: ProductDefinition }, ApplicationProduct>;
  "wanxApplicationsGet": Op<{ readonly path: ApplicationPath }, ApplicationProduct>;
  "wanxApplicationsUpdate": Op<{ readonly path: ApplicationPath; readonly body: Partial<Omit<ProductDefinition, "application_id">> }, ApplicationProduct>;
  "wanxApplicationsDeploymentGet": Op<{ readonly path: ApplicationPath }, ApplicationDeployment>;
  "wanxApplicationsDeploymentPut": Op<{ readonly path: ApplicationPath; readonly body: DeploymentConfiguration }, ApplicationDeployment>;
  "wanxApplicationsReleasesList": Op<{ readonly path: ApplicationPath }, readonly ClientRelease[]>;
  "wanxApplicationsReleasesCreate": Op<{ readonly path: ApplicationPath; readonly body: ClientReleaseInput }, ClientRelease>;
  "wanxApplicationsReleaseRecommend": Op<{ readonly path: ApplicationPath & { readonly version: string }; readonly body: { readonly platform: ClientPlatform; readonly arch: ClientArchitecture } }, ClientRelease>;
  "wanxApplicationsAccessList": Op<{ readonly path: ApplicationPath }, readonly ApplicationAccess[]>;
  "wanxApplicationsAccessPut": Op<{ readonly path: ApplicationPath; readonly body: { readonly user_id: number; readonly enabled: boolean } }, ApplicationAccess>;
  "wanxApplicationsManifestGet": Op<{ readonly path: ApplicationPath }, ApplicationManifest>;
  "wanxApplicationsCompatibleRelease": Op<{ readonly path: ApplicationPath; readonly query: ReleaseQuery }, CompatibleRelease>;
}
