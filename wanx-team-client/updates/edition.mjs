import { isTestClientIdentity } from "./test-build.mjs";

const applicationEditions = Object.freeze({
  "ai.centuarai.wanx.client": "personal",
  "ai.centuarai.wanx.studio.team.local": "team",
});
const testApplicationEditions = Object.freeze({
  "ai.centuarai.wanx.client.ota-test": "personal",
  "ai.centuarai.wanx.studio.team.ota-test": "team",
});

export const validClientEdition = value => value === "personal" || value === "team";
export function editionForApplicationId(applicationId, { testOnly = false } = {}) {
  const editions = testOnly ? testApplicationEditions : applicationEditions;
  return typeof applicationId === "string" && Object.hasOwn(editions, applicationId) ? editions[applicationId] : null;
}

export function editionMatchesChannel(edition, channel, testIdentity) {
  if (!validClientEdition(edition) || typeof channel !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(channel)) return false;
  if (isTestClientIdentity(testIdentity) && channel === testIdentity.channel)
    return editionForApplicationId(testIdentity.applicationId, { testOnly: true }) === edition;
  return edition === "team" ? channel.endsWith("-studio") : !channel.endsWith("-studio");
}
