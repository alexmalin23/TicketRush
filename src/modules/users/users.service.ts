import { Injectable, NotFoundException } from "../../core";
import { User, UsersModel } from "./users.model";

@Injectable()
export class UsersService {
  constructor(private readonly usersModel: UsersModel) {}

  findAll(): Promise<User[]> {
    return this.usersModel.findAll();
  }

  async findById(id: number): Promise<User> {
    const user = await this.usersModel.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }
}
