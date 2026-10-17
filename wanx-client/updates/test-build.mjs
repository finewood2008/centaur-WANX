export const TEST_APP_ID = "ai.centuarai.wanx.client.ota-test";
export const TEST_PACKAGE_NAME = "centuarai-wanx-client-ota-test";
export const TEST_PRODUCT_NAME = "万象升级测试";
export const TEST_EXTENSION = "wanx.client-test.v1";

export function validTestRunId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,19}$/.test(value);
}

export function isTestClientIdentity(value) {
  return value?.packaged === true && value.distributionClass === "test-only" &&
    value.applicationId === TEST_APP_ID && validTestRunId(value.testRunId) &&
    value.channel === `test-client-${value.testRunId}`;
}

export function testPackageIdentity(pkg) {
  if (pkg?.wanxBuild?.distributionClass !== "test-only") return null;
  const value = { ...pkg.wanxBuild, packaged: true };
  if (pkg.name !== TEST_PACKAGE_NAME || pkg.productName !== TEST_PRODUCT_NAME || !isTestClientIdentity(value))
    throw new Error("UPDATE_TEST_CONFIGURATION_INVALID");
  return value;
}
