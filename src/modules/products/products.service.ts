import { Injectable, NotFoundException } from "../../core";
import { PaginationQuery } from "../../common/validators/common.schemas";
import { Product, ProductsModel } from "./products.model";
import { CreateProductInput, UpdateProductInput } from "./products.schemas";

/**
 * Business logic layer. Decides what "not found" means and throws HTTP exceptions;
 * the global exception handler turns them into responses.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly productsModel: ProductsModel) {}

  findAll(pagination: PaginationQuery): Promise<Product[]> {
    return this.productsModel.findAll(pagination);
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsModel.findById(id);
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  create(data: CreateProductInput): Promise<Product> {
    return this.productsModel.create(data);
  }

  async update(id: number, data: UpdateProductInput): Promise<Product> {
    const product = await this.productsModel.update(id, data);
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  async remove(id: number): Promise<void> {
    const deleted = await this.productsModel.delete(id);
    if (!deleted) throw new NotFoundException(`Product ${id} not found`);
  }
}
