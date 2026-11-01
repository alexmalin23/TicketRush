import { Injectable, ServiceUnavailableException } from "../../core";
import { RedisService } from "../../database/redis.service";

const key = (tokenId: string) => `revoked-token:${tokenId}`;

/**
 * Tokens revoked before they expire (logout), shared by every API replica through Redis.
 *
 * Each entry lives exactly as long as its token would have: once the token expires the signature
 * check rejects it anyway, and Redis deletes the entry on its own. The list only ever holds
 * revoked tokens that are still alive, with no cleanup job.
 *
 * Fails closed: if Redis cannot be asked, the request is refused with 503 rather than trusting a
 * token that may have been revoked. 503, not 401: the token is not the problem, the server is.
 */
@Injectable()
export class TokenDenylist {
  constructor(private readonly redis: RedisService) {}

  async add(tokenId: string, expiresAt: number): Promise<void> {
    const secondsLeft = expiresAt - Math.floor(Date.now() / 1000);
    if (secondsLeft <= 0) return;
    await this.ask(() => this.redis.client.set(key(tokenId), "1", "EX", secondsLeft));
  }

  async has(tokenId: string): Promise<boolean> {
    return (await this.ask(() => this.redis.client.exists(key(tokenId)))) === 1;
  }

  private async ask<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch {
      throw new ServiceUnavailableException("Token revocation cannot be checked, please retry");
    }
  }
}
