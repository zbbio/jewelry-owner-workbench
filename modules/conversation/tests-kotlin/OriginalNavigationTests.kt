// Extracted from Mika by wangzan101 (Apache-2.0), commit e8479330f7284dd0031649636e18e197d6633ece.
// K1 change: selected lines compiled with host-projection types, not Mika Android runtime.
package com.wangzan101.mika.chat.ui

internal class OriginalNavigationTests {
    private fun vm() = OriginalJumpOps()
    @Test
    fun targetKeysPointAtTheRenderedRow() {
        val steer = SteerNote("s1", "改成靠窗", SteerState.Joined, interrupted = "被打断", finished = "正在改")
        val done = Exchange(
            "买票", emptyList(), ExchangeStatus.Done("完成", null), live = false, runId = "run",
            steers = listOf(steer),
            files = listOf(SharedFile("a.txt", 1L, "a.txt", "content://a")),
        )
        val list = listOf(done)
        assertEquals("u0", chatTargetKey(list, ChatTarget.Message(0, null)))
        assertEquals("m0-s1", chatTargetKey(list, ChatTarget.Message(0, 0)))
        assertEquals("u0", chatTargetKey(list, ChatTarget.Reply(0, 0, interrupted = false)))
        assertEquals("u0", chatTargetKey(list, ChatTarget.Reply(0, 0, interrupted = true)))
        assertEquals("f0", chatTargetKey(list, ChatTarget.Files(0)))
        assertEquals("r0", chatTargetKey(list, ChatTarget.Status(0)))
        assertNull(chatTargetKey(list, ChatTarget.Message(1, null)))
    }

    @Test
    fun withdrawnSteerFallsBackToTheTurnStart() {
        val withdrawn = SteerNote("s1", "撤回的话", SteerState.Withdrawn)
        val done = Exchange("问", emptyList(), ExchangeStatus.Done("答", null), live = false, steers = listOf(withdrawn))
        assertEquals("u0", chatTargetKey(listOf(done), ChatTarget.Message(0, 0)))
    }

    @Test fun openingAtAMessageKeepsTheTargetForTheChatPage() = runTest {
        val vm = vm()
        vm.openConversation("a")
        vm.openConversationAt("b", ChatTarget.Message(1, null))
        assertEquals("b", vm.ui.value.conversationId)
        assertEquals(ChatTarget.Message(1, null), vm.jump.value?.target)

        val first = vm.jump.value!!
        vm.consumeJump(first)
        assertNull(vm.jump.value)

        // 已经在这个对话里也要能重新跳;serial 让聊天页把同一处当成新请求
        vm.openConversationAt("b", ChatTarget.Status(2))
        assertEquals("b", vm.ui.value.conversationId)
        assertEquals(ChatTarget.Status(2), vm.jump.value?.target)
        assertTrue(vm.jump.value!!.serial > first.serial)
    }
}
