import { Inject, Injectable, Logger, ServiceUnavailableException } from "../../core";
import { ENV, Env } from "../../config/env";

export interface ChargeRequest {
  /** Same key on every retry of the same payment: the provider then charges at most once. */
  idempotencyKey: string;
  amountCents: number;
}

/**
 * - succeeded / declined: the provider answered.
 * - timeout: no answer in time. The charge MAY have happened. Never treat it as declined;
 *   retry with the same idempotency key to find out the real outcome.
 */
export type ChargeOutcome =
  | { status: "succeeded"; providerRef: string }
  | { status: "declined"; providerRef: string }
  | { status: "timeout" };

/** HTTP client of the card processor. The provider is an external system: every call can be slow or lost. */
@Injectable()
export class PaymentsClient {
  private readonly logger: Logger;

  constructor(
    @Inject(ENV) private readonly env: Env,
    logger: Logger
  ) {
    this.logger = logger.child("Payments");
  }

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    let response: Response;
    try {
      response = await fetch(new URL("/charges", this.env.PAYMENTS_PROVIDER_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.env.PAYMENT_TIMEOUT_MS),
      });
    } catch (error) {
      if ((error as Error).name === "TimeoutError") {
        this.logger.warn("Charge outcome unknown: provider did not answer in time", {
          idempotencyKey: request.idempotencyKey,
          timeoutMs: this.env.PAYMENT_TIMEOUT_MS,
        });
        return { status: "timeout" };
      }
      // Connection refused / DNS: the request never reached the provider, nothing was charged.
      throw new ServiceUnavailableException("Payment provider unreachable", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(`Payment provider answered ${response.status}`, undefined, "PAYMENT_PROVIDER_ERROR");
    }
    const charge = (await response.json()) as { status: "succeeded" | "declined"; providerRef: string };
    return { status: charge.status, providerRef: charge.providerRef };
  }
}
