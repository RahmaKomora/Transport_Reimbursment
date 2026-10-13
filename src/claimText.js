/**
 * A claim's reason as people should read it: "Other" carries what the other reason was.
 *
 * The explanation is stored apart from the reasons (claims.other_reason) so exports keep
 * it in a column of its own, and joined back here for every list and detail view.
 */
export function reasonOf(claim) {
  const purpose = claim?.purpose || '';
  if (!claim?.otherReason) return purpose;
  return purpose.split(', ').map((item) => (item === 'Other' ? `Other: ${claim.otherReason}` : item)).join(', ');
}
