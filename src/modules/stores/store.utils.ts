export function withMembershipRole<
  T extends { memberships: Array<{ role: string }> },
>(store: T): Omit<T, 'memberships'> & { role: string | undefined } {
  const { memberships, ...rest } = store;
  return { ...rest, role: memberships[0]?.role };
}
