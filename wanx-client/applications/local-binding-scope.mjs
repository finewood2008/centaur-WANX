const fields = ['schemaVersion', 'authorization', 'boxKeyThumbprint', 'principalId', 'deviceId', 'ownershipEpoch', 'artifactId'];
export function localBindingScope(value, expected = {}) {
  const fail = () => { throw Object.assign(new Error('APPLICATION_PREPARATION_INVALID'), { code: 'APPLICATION_PREPARATION_INVALID' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
      || !fields.every(key => Object.hasOwn(value, key)) || value.schemaVersion !== 2 || value.authorization !== 'local-trust-v1'
      || typeof value.boxKeyThumbprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.boxKeyThumbprint)
      || Buffer.from(value.boxKeyThumbprint, 'base64url').toString('base64url') !== value.boxKeyThumbprint
      || ['principalId', 'deviceId', 'artifactId'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 256)
      || !Number.isSafeInteger(value.ownershipEpoch) || value.ownershipEpoch < 1
      || Object.entries(expected).some(([key, item]) => value[key] !== item)) fail();
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
