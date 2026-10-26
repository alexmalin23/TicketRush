import { Inject, Injectable, Logger, NotFoundException } from "../../core";
import { ENV, Env } from "../../config/env";
import { DatabaseService } from "../../database/database.service";
import { resetEvent } from "../../database/seed";

@Injectable()
export class DevService {
  private readonly logger: Logger;

  constructor(
    @Inject(ENV) private readonly env: Env,
    logger: Logger,
    private readonly database: DatabaseService
  ) {
    this.logger = logger.child("Dev");
  }

  /**
   * Same reset as `npm run db:reset`, in one transaction: a load run never sees half of it.
   * The mock provider's ledger is cleared too: its charges belong to the orders just deleted, and
   * the invariants compare the two records, so a stale ledger would report charges without orders.
   */
  async resetEvent(eventId: number): Promise<{ eventId: number; seatsAvailable: number }> {
    const seats = await this.database.transaction((client) => resetEvent(client, eventId));
    if (seats === null) throw new NotFoundException(`Event ${eventId} not found`);
    await this.clearProviderLedger();
    return { eventId, seatsAvailable: seats };
  }

  private async clearProviderLedger(): Promise<void> {
    try {
      await fetch(new URL("/ledger", this.env.PAYMENTS_PROVIDER_URL), { method: "DELETE", signal: AbortSignal.timeout(3000) });
    } catch {
      // Without a provider there is no ledger to be stale; the invariants endpoint will say so itself.
      this.logger.warn("Could not clear the payment provider ledger", { url: this.env.PAYMENTS_PROVIDER_URL });
    }
  }
}
