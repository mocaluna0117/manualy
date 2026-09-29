-- CreateIndex
CREATE INDEX "Conversation_user_id_updatedAt_idx" ON "Conversation"("user_id", "updatedAt");

-- CreateIndex
CREATE INDEX "Manual_categoryId_createdAt_idx" ON "Manual"("categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_conversation_id_created_at_idx" ON "Message"("conversation_id", "created_at");
