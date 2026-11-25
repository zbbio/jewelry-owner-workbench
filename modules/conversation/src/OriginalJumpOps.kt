// Extracted from Mika by wangzan101 (Apache-2.0), commit e8479330f7284dd0031649636e18e197d6633ece.
// K1 change: selected lines compiled with host-projection types, not Mika Android runtime.
package com.wangzan101.mika.chat.ui

internal class OriginalJumpOps {
    private val _ui = Cell(TopicUi(null))
    private val _jump = Cell<ChatJump?>(null)
    val ui get() = _ui
    val jump get() = _jump
    var jumpSerial = 0L
        private set
    fun openConversation(id: String) { _jump.value = null; _ui.value = TopicUi(id) }

    /**
     * 打开某个对话并跳到指定消息。已经在这个对话里时只设跳转,不重新载入;
     * 任务进行中且没开并行时打不开,跳转也不会留下,调用方可以用 [ChatUi.conversationId] 判断是否成功。
     */
    fun openConversationAt(id: String, target: ChatTarget) {
        if (_ui.value.conversationId != id) openConversation(id)
        if (_ui.value.conversationId == id) _jump.value = ChatJump(id, target, ++jumpSerial)
    }

    /** 聊天页滚到目标后清掉请求;期间又来了新请求时不要误清。 */
    fun consumeJump(jump: ChatJump) {
        _jump.update { if (it == jump) null else it }
    }
}
