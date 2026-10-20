import { Injectable, NotFoundException } from "../../core";
import { DatabaseService } from "../../database/database.service";
import { resetEvent } from "../../database/seed";

@Injectable()
export class DevService {
  constructor(private readonly database: DatabaseService) {}

  /** Same reset as `npm run db:reset`, in one transaction: a load run never sees half of it. */
  async resetEvent(eventId: number): Promise<{ eventId: number; seatsAvailable: number }> {
    const seats = await this.database.transaction((client) => resetEvent(client, eventId));
    if (seats === null) throw new NotFoundException(`Event ${eventId} not found`);
    return { eventId, seatsAvailable: seats };
  }
}
