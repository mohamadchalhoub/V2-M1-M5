-- AlterTable
ALTER TABLE "api_credentials" ADD COLUMN     "account_id" TEXT;

-- CreateIndex
CREATE INDEX "api_credentials_account_id_idx" ON "api_credentials"("account_id");

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
