@file:OptIn(ExperimentalJsExport::class)

import com.wangzan101.mika.chat.ui.*

/** One projection per mounted owner view. No credentials, store, dispatch or persistence. */
@JsExport
class Navigation {
    private val ops = OriginalJumpOps()

    /** Only the host's explicit selection/re-authentication should call this method. */
    fun selectTopic(id: String) {
        ops.openConversation(id)
    }

    fun openMessage(topicId: String, messageId: String, visibleChronologicalMessageIds: Array<String>): String? =
        open(topicId, messageId, visibleChronologicalMessageIds, result = false)

    fun openResult(topicId: String, messageId: String, visibleChronologicalMessageIds: Array<String>): String? =
        open(topicId, messageId, visibleChronologicalMessageIds, result = true)

    fun jumpSerial(): String = ops.jumpSerial.toString()

    private fun open(topic: String, message: String, ids: Array<String>, result: Boolean): String? {
        // The active selection never follows asynchronous arrivals. ids must come from
        // this authenticated conversation's currently validated history, oldest first.
        if (topic.isBlank() || topic != ops.ui.value.conversationId || message.isBlank()) return null
        val i = ids.indexOf(message)
        if (i < 0 || ids.any { it.isBlank() } || ids.toSet().size != ids.size) return null
        val target = if (result) ChatTarget.Status(i) else ChatTarget.Message(i, null)
        ops.openConversationAt(topic, target)
        val request = ops.jump.value ?: return null
        // P1 only accepts non-empty user text. Use the validated opaque ID as a
        // presence marker instead of copying message bodies into the Kotlin layer.
        val rows = ids.map { Exchange(goal = it) }
        val key = chatTargetKey(rows, request.target)
        ops.consumeJump(request)
        return key
    }
}

@JsExport
fun createNavigation(): Navigation = Navigation()
