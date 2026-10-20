import { ConflictException, UnauthorizedException } from "../../src/core";
import { AuthService } from "../../src/modules/auth/auth.service";
import { hashPassword, verifyPassword } from "../../src/modules/auth/password";
import { TokenService } from "../../src/modules/auth/token.service";
import { UsersModel } from "../../src/modules/users/users.model";

/**
 * Services are plain classes: we build them with `new` and hand-made mocks.
 * No container, no database. This is the testability that DI buys us.
 */

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    await expect(verifyPassword("correct horse", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
    await expect(verifyPassword("x", "garbage")).resolves.toBe(false);
  });

  it("uses a random salt (same password, different hash)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });
});

describe("AuthService", () => {
  const users = { findByEmailWithPassword: jest.fn(), create: jest.fn() };
  const tokens = { sign: jest.fn() };
  const service = new AuthService(users as unknown as UsersModel, tokens as unknown as TokenService);
  const user = { id: 1, email: "a@b.co", role: "user" as const, createdAt: new Date() };

  beforeEach(() => {
    jest.resetAllMocks();
    tokens.sign.mockReturnValue("token");
  });

  it("refuses to register an existing email", async () => {
    users.findByEmailWithPassword.mockResolvedValue({ ...user, passwordHash: "x" });
    await expect(service.register({ email: user.email, password: "password1" })).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(users.create).not.toHaveBeenCalled();
  });

  it("stores a hash, never the plain password", async () => {
    users.findByEmailWithPassword.mockResolvedValue(null);
    users.create.mockResolvedValue(user);
    await service.register({ email: user.email, password: "password1" });

    const saved = users.create.mock.calls[0][0];
    expect(saved.passwordHash).not.toContain("password1");
    await expect(verifyPassword("password1", saved.passwordHash)).resolves.toBe(true);
  });

  it("gives the same error for an unknown email and a wrong password", async () => {
    users.findByEmailWithPassword.mockResolvedValue(null);
    const unknown = service.login({ email: "x@y.co", password: "whatever" });
    await expect(unknown).rejects.toThrow("Invalid email or password");

    users.findByEmailWithPassword.mockResolvedValue({ ...user, passwordHash: await hashPassword("right") });
    const wrong = service.login({ email: user.email, password: "wrong" });
    await expect(wrong).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(wrong).rejects.toThrow("Invalid email or password");
  });

  it("logs in and never returns the hash", async () => {
    users.findByEmailWithPassword.mockResolvedValue({ ...user, passwordHash: await hashPassword("right") });
    const result = await service.login({ email: user.email, password: "right" });
    expect(result.accessToken).toBe("token");
    expect(result.user).not.toHaveProperty("passwordHash");
  });
});
