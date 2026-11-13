CREATE INDEX "screen_captures_organization_id_device_id_captured_at_idx"
ON "screen_captures"("organization_id", "device_id", "captured_at");

CREATE INDEX "screen_captures_organization_id_employee_id_captured_at_idx"
ON "screen_captures"("organization_id", "employee_id", "captured_at");
