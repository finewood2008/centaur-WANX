import type { ApplicationProfile, ApplicationAccess, ApplicationDeployment, ApplicationManifest, ApplicationProduct, ClientArchitecture, ClientPlatform, ClientRelease, ClientReleaseInput, CompatibleRelease, DeploymentConfiguration, ProductDefinition, ReleaseQuery } from "./application-contracts.js";
import type { CallOptions, Modules, NativeResponse } from "./types.js";
/** Convenience facade; every method passes the existing operation policy and transport. */
export interface ApplicationsApi {
  getProfile(applicationId: string, options?: CallOptions): Promise<NativeResponse<ApplicationProfile>>;
  createProfile(applicationId: string, options?: CallOptions): Promise<NativeResponse<ApplicationProfile>>;
  list(options?: CallOptions): Promise<NativeResponse<readonly ApplicationProduct[]>>;
  create(product: ProductDefinition, options?: CallOptions): Promise<NativeResponse<ApplicationProduct>>;
  get(applicationId: string, options?: CallOptions): Promise<NativeResponse<ApplicationProduct>>;
  update(applicationId: string, product: Partial<Omit<ProductDefinition, "application_id">>, options?: CallOptions): Promise<NativeResponse<ApplicationProduct>>;
  getDeployment(applicationId: string, options?: CallOptions): Promise<NativeResponse<ApplicationDeployment>>;
  putDeployment(applicationId: string, deployment: DeploymentConfiguration, options?: CallOptions): Promise<NativeResponse<ApplicationDeployment>>;
  listReleases(applicationId: string, options?: CallOptions): Promise<NativeResponse<readonly ClientRelease[]>>;
  createRelease(applicationId: string, release: ClientReleaseInput, options?: CallOptions): Promise<NativeResponse<ClientRelease>>;
  recommendRelease(applicationId: string, version: string, target: { platform: ClientPlatform; arch: ClientArchitecture }, options?: CallOptions): Promise<NativeResponse<ClientRelease>>;
  listAccess(applicationId: string, options?: CallOptions): Promise<NativeResponse<readonly ApplicationAccess[]>>;
  putAccess(applicationId: string, access: { user_id: number; enabled: boolean }, options?: CallOptions): Promise<NativeResponse<ApplicationAccess>>;
  getManifest(applicationId: string, options?: CallOptions): Promise<NativeResponse<ApplicationManifest>>;
  compatibleRelease(applicationId: string, query: ReleaseQuery, options?: CallOptions): Promise<NativeResponse<CompatibleRelease>>;
}
export function applicationsFacade(modules: Modules): ApplicationsApi {
  const api = modules.applications;
  const path = (applicationId: string) => ({ application_id: applicationId });
  return Object.freeze({
    getProfile: (id, options) => api.getProfile({ path: path(id) }, options),
    createProfile: (id, options) => api.createProfile({ path: path(id) }, options),
    list: options => api.list({}, options),
    create: (body, options) => api.create({ body }, options),
    get: (id, options) => api.get({ path: path(id) }, options),
    update: (id, body, options) => api.update({ path: path(id), body }, options),
    getDeployment: (id, options) => api.getDeployment({ path: path(id) }, options),
    putDeployment: (id, body, options) => api.putDeployment({ path: path(id), body }, options),
    listReleases: (id, options) => api.listReleases({ path: path(id) }, options),
    createRelease: (id, body, options) => api.createRelease({ path: path(id), body }, options),
    recommendRelease: (id, version, body, options) => api.recommendRelease({ path: { ...path(id), version }, body }, options),
    listAccess: (id, options) => api.listAccess({ path: path(id) }, options),
    putAccess: (id, body, options) => api.putAccess({ path: path(id), body }, options),
    getManifest: (id, options) => api.getManifest({ path: path(id) }, options),
    compatibleRelease: (id, query, options) => api.compatibleRelease({ path: path(id), query }, options),
  } satisfies ApplicationsApi);
}
