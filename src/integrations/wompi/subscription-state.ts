import type { WompiProviderStatus } from './contracts.js';

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Canonical subscription commands triggered by a verified/reconciled payment status. */
export function subscriptionStatusAfterWompiPayment(
  current: SubscriptionStatus,
  paymentStatus: WompiProviderStatus,
): SubscriptionStatus {
  if (paymentStatus === 'APPROVED' && ['trialing', 'past_due', 'suspended'].includes(current)) {
    return 'active';
  }
  if (paymentStatus === 'DECLINED' && current === 'active') return 'past_due';
  return current;
}
