import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ledgerDigest,
  signLedgerMutation,
  signLedgerTargetAccess,
  signLedgerTargetApproval,
  signTeamRequestAccess,
  signTeamRequestApproval,
  validateTeamMembershipRequest,
  verifyTeamIdentityProof,
  verifyTeamRequestAccess,
  verifyTeamRequestApproval,
  verifyLedgerResponse,
} from '../../../wanx-team-client/device-trust/ledger-contract.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
try {
  let value;
  if (input.operation === 'verify-cloud') {
    value = verifyTeamIdentityProof(input.proof, input.options);
  } else if (input.operation === 'sign-request') {
    const key = createPrivateKey(input.privateKey);
    const sign = input.purpose === 'request-access' ? signTeamRequestAccess : signTeamRequestApproval;
    value = { proof: sign(input.request, key), digest: ledgerDigest(input.request) };
  } else if (input.operation === 'verify-request') {
    const verify = input.purpose === 'request-access' ? verifyTeamRequestAccess : verifyTeamRequestApproval;
    value = verify(input.proof, input.publicKey);
  } else if (input.operation === 'validate-request') {
    value = validateTeamMembershipRequest(input.request);
  } else if (input.operation === 'sign-mutation') {
    const signer = { mutation: signLedgerMutation, 'target-access': signLedgerTargetAccess,
      'target-approval': signLedgerTargetApproval }[input.purpose];
    value = signer(input.mutation, createPrivateKey(input.privateKey));
  } else if (input.operation === 'verify-response') {
    value = verifyLedgerResponse(input.proof, input.options);
  } else {
    throw new Error('UNKNOWN_VECTOR_OPERATION');
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || error.name }));
}
