import {
  createSharedKey,
  decryptOrcaMessage,
  encryptOrcaMessage,
} from "./crypto";
import type { OrcaPairingOffer } from "./pairing";

type RpcResponse<T> =
  | { id: string; ok: true; result: T }
  | { id: string; ok: false; error: { code: string; message: string } };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
};

export class OrcaRuntimeClient {
  private socket: WebSocket | null = null;
  private sharedKey: Uint8Array | null = null;
  private connected: Promise<void>;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: Error) => void;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly pairing: OrcaPairingOffer) {
    this.connected = new Promise((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    this.open();
  }

  async call<T>(method: string, params: unknown = {}): Promise<T> {
    await this.connected;
    const id = `buzz-orca-${Date.now()}-${++this.requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Orca request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.send({ id, deviceToken: this.pairing.deviceToken, method, params });
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.failPending(new Error("Orca connection closed."));
  }

  private open() {
    const socket = new WebSocket(this.pairing.endpoint);
    this.socket = socket;
    socket.onopen = () => {
      const handshake = createSharedKey(this.pairing.publicKeyB64);
      this.sharedKey = handshake.sharedKey;
      socket.send(
        JSON.stringify({
          type: "e2ee_hello",
          publicKeyB64: handshake.publicKeyB64,
        }),
      );
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      this.rejectConnected(new Error("Could not connect to Orca."));
    };
    socket.onclose = () => {
      this.rejectConnected(new Error("Orca connection closed."));
      this.failPending(new Error("Orca connection closed."));
    };
  }

  private handleMessage(data: unknown) {
    if (typeof data !== "string" || !this.sharedKey) return;
    try {
      const plaintext = JSON.parse(data) as { type?: string };
      if (plaintext.type === "e2ee_ready") {
        this.send({
          type: "e2ee_auth",
          deviceToken: this.pairing.deviceToken,
          clientCapabilities: [],
        });
        return;
      }
    } catch {
      // Authenticated Orca frames are encrypted strings.
    }

    const message = decryptOrcaMessage(data, this.sharedKey) as
      | RpcResponse<unknown>
      | { type?: string; error?: { message?: string } }
      | null;
    if (!message) return;
    if ("type" in message && message.type === "e2ee_authenticated") {
      this.resolveConnected();
      return;
    }
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    window.clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error.message));
  }

  private send(value: unknown) {
    if (!this.socket || !this.sharedKey) {
      throw new Error("Orca is not connected.");
    }
    this.socket.send(encryptOrcaMessage(value, this.sharedKey));
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
