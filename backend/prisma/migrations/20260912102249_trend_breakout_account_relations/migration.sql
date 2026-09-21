-- AddForeignKey
ALTER TABLE "trend_breakout_risk_states" ADD CONSTRAINT "trend_breakout_risk_states_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_breakout_slot_locks" ADD CONSTRAINT "trend_breakout_slot_locks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_breakout_decisions" ADD CONSTRAINT "trend_breakout_decisions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_breakout_emergency_incidents" ADD CONSTRAINT "trend_breakout_emergency_incidents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
