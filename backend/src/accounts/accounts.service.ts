import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrThrow(accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException(`No trading account with id ${accountId}`);
    }
    return account;
  }
}
