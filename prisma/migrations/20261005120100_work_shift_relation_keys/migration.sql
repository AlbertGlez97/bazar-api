-- Composite unique relation keys required by Prisma one-to-one tenant edges.
CREATE UNIQUE INDEX "WorkShiftReversal_workShiftId_contextId_key" ON "WorkShiftReversal"("workShiftId", "contextId");
CREATE UNIQUE INDEX "WorkShiftReversal_replacementWorkShiftId_contextId_key" ON "WorkShiftReversal"("replacementWorkShiftId", "contextId");
