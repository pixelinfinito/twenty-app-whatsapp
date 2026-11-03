import { describe, expect, it } from 'vitest';

import { registrationFault } from './wa-account-admin-route';

/**
 * The two fields that decide whether a webhook can ever fire — and the reason
 * they are worth their own check.
 *
 * Diagnosed on a live install: `code_verification_status: EXPIRED` on a number
 * whose every other signal was healthy. Meta kept delivering messages to the
 * phone (two ticks on the sender's screen) and stopped emitting events, which
 * is indistinguishable from a broken webhook from every angle except this one.
 * Hours went into the edge, the proxy, the signature and the routing claims
 * before anything pointed here.
 */
describe('registrationFault', () => {
  it('passes a correctly registered number', () => {
    expect(
      registrationFault({ platformType: 'CLOUD_API', codeVerificationStatus: 'VERIFIED' }),
    ).toBeNull();
  });

  it('names an expired verification, which is the live case', () => {
    const fault = registrationFault({
      platformType: 'CLOUD_API',
      codeVerificationStatus: 'EXPIRED',
    });

    expect(fault).toContain('EXPIRED');
    expect(fault).toContain('re-verifying');
  });

  it('names a number that is not on the Cloud API', () => {
    expect(registrationFault({ platformType: 'NOT_APPLICABLE' })).toContain('NOT_APPLICABLE');
    expect(registrationFault({ platformType: 'ON_PREMISE' })).toContain('ON_PREMISE');
  });

  /**
   * Platform first: a number that is not on the Cloud API at all makes its
   * verification status beside the point, and reporting both would bury the
   * one the operator has to act on.
   */
  it('reports the platform before the verification when both are wrong', () => {
    expect(
      registrationFault({ platformType: 'ON_PREMISE', codeVerificationStatus: 'EXPIRED' }),
    ).toContain('ON_PREMISE');
  });

  /**
   * Silence on absent fields, not a false alarm. An older Graph version — or a
   * provider that does not return them — must not paint every healthy number
   * as broken.
   */
  it.each([{}, { platformType: null, codeVerificationStatus: null }, { platformType: '' }])(
    'says nothing when the fields are absent: %p',
    (input) => {
      expect(registrationFault(input)).toBeNull();
    },
  );

  it('is case-insensitive about what Meta returns', () => {
    expect(
      registrationFault({ platformType: 'cloud_api', codeVerificationStatus: 'verified' }),
    ).toBeNull();
  });
});
