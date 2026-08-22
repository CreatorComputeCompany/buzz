export type OrcaRuntimeTicket = {
  pairingUrl: string;
  worktreeId?: string;
  email?: string;
  member?: {
    key: string;
    displayName: string;
    deviceIds?: string[];
  };
};

export function toOrcaRuntimeResponse(ticket: OrcaRuntimeTicket) {
  const response = {
    pairingUrl: ticket.pairingUrl,
    ...(ticket.worktreeId ? { worktreeId: ticket.worktreeId } : {}),
  };
  if (
    typeof ticket.email !== "string" ||
    typeof ticket.member?.key !== "string" ||
    typeof ticket.member.displayName !== "string"
  ) {
    return response;
  }
  return {
    ...response,
    orcaAuth: {
      pairingUrl: ticket.pairingUrl,
      email: ticket.email,
      member: {
        key: ticket.member.key,
        displayName: ticket.member.displayName,
        deviceIds: ticket.member.deviceIds ?? [],
      },
    },
  };
}
