/** Setup was interrupted by the user (Ctrl-C, closed terminal). Progress is saved; this is a normal exit, not a failure. */
export class OnboardingCancelled extends Error {
  constructor(message = 'Setup stopped. Your progress is saved; run wabgpt again to continue.') {
    super(message);
    this.name = 'OnboardingCancelled';
  }
}
