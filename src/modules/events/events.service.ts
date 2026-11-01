import { Inject, Injectable, NotFoundException } from "../../core";
import { HOLD_STORE, HoldStore } from "../holds/hold-store";
import { SeatsModel, SeatView, SectionAvailability, SectionPrice } from "../seats/seats.model";
import { EventDetail, EventsModel, EventSummary } from "./events.model";

@Injectable()
export class EventsService {
  constructor(
    private readonly eventsModel: EventsModel,
    private readonly seatsModel: SeatsModel,
    // Which seats are free depends on where holds live.
    @Inject(HOLD_STORE) private readonly holds: HoldStore
  ) {}

  findAll(): Promise<EventSummary[]> {
    return this.eventsModel.findAll();
  }

  async findOne(id: number): Promise<EventDetail & { sections: SectionPrice[] }> {
    const event = await this.requireEvent(id);
    return { ...event, sections: await this.seatsModel.sectionPrices(id) };
  }

  /** The cheap summary: counts only, so clients can poll it without loading every seat. */
  async availability(id: number): Promise<{ sections: SectionAvailability[] }> {
    await this.requireEvent(id);
    return { sections: await this.holds.availability(id) };
  }

  async seatMap(id: number, section: string): Promise<{ section: string; seats: SeatView[] }> {
    await this.requireEvent(id);
    const seats = await this.holds.seatMap(id, section);
    if (seats.length === 0) throw new NotFoundException(`Section ${section} not found`);
    return { section, seats };
  }

  private async requireEvent(id: number): Promise<EventDetail> {
    const event = await this.eventsModel.findById(id);
    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }
}
