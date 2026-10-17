// Public profile fields only. The existing account vault provides OS encryption.
export function validateProfilePatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !Object.keys(input).length || Object.keys(input).some(key => !["displayName", "avatarDataUrl"].includes(key)))
    throw new Error("PROFILE_INVALID_INPUT");
  const patch = {};
  if (Object.hasOwn(input, "displayName")) {
    if (typeof input.displayName !== "string" || !input.displayName.trim() ||
        [...input.displayName.trim()].length > 40 || /[\u0000-\u001f\u007f]/.test(input.displayName))
      throw new Error("PROFILE_INVALID_NAME");
    patch.displayName = input.displayName.trim();
  }
  if (Object.hasOwn(input, "avatarDataUrl")) {
    const avatar = input.avatarDataUrl;
    if (avatar !== null && (typeof avatar !== "string" || avatar.length > 512000 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar) ||
        !Buffer.from(avatar.slice(22), "base64").subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))
      throw new Error("PROFILE_INVALID_AVATAR");
    patch.avatarDataUrl = avatar;
  }
  return patch;
}

export function publicProfile(value) {
  const result = { displayName: "", avatarDataUrl: null, storage: "local" };
  for (const key of ["displayName", "avatarDataUrl"]) {
    if (value?.[key] === undefined || (key === "displayName" && !value[key])) continue;
    try { Object.assign(result, validateProfilePatch({ [key]: value[key] })); } catch { /* ignore corrupt stored fields */ }
  }
  return result;
}
