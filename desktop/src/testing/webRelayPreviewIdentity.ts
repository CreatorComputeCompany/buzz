export type WebRelayPreviewIdentity = {
  privateKey: string;
  pubkey: string;
  username: string;
};

const DEFAULT_PREVIEW_USER = "tyler";

const WEB_RELAY_PREVIEW_IDENTITIES = {
  tyler: {
    privateKey:
      "3dbaebadb5dfd777ff25149ee230d907a15a9e1294b40b830661e65bb42f6c03",
    pubkey: "e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34",
    username: "tyler",
  },
  alice: {
    privateKey:
      "3fa69cbac1dcb9b7b6ac83117c74bd23bb1e717fe8fc7cfda67b47bb4323383d",
    pubkey: "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
    username: "alice",
  },
} as const satisfies Record<string, WebRelayPreviewIdentity>;

export function selectWebRelayPreviewIdentity(
  searchParams: URLSearchParams,
): WebRelayPreviewIdentity {
  const requestedUser =
    searchParams.get("previewUser")?.trim().toLowerCase() ||
    DEFAULT_PREVIEW_USER;
  const identity =
    WEB_RELAY_PREVIEW_IDENTITIES[
      requestedUser as keyof typeof WEB_RELAY_PREVIEW_IDENTITIES
    ];

  if (!identity) {
    throw new Error(
      `Unknown local preview user: ${requestedUser}. Expected tyler or alice.`,
    );
  }

  return identity;
}
