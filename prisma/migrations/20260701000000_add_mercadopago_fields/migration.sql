-- AlterTable: add Mercado Pago integration fields
ALTER TABLE "Payment" ADD COLUMN     "description" TEXT;
ALTER TABLE "Payment" ADD COLUMN     "payerEmail" TEXT;
ALTER TABLE "Payment" ADD COLUMN     "mpPreferenceId" TEXT;
ALTER TABLE "Payment" ADD COLUMN     "mpPaymentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN     "initPoint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_mpPreferenceId_key" ON "Payment"("mpPreferenceId");
CREATE UNIQUE INDEX "Payment_mpPaymentId_key" ON "Payment"("mpPaymentId");
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
