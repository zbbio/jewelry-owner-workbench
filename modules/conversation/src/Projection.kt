package com.wangzan101.mika.chat.ui

// K1-owned, presentation-only. No disk, auth, network, coroutines, or model port.
// These are just the fields read by ChatRows or constructed by its upstream tests.
internal class Cell<T>(var value: T) {
    fun update(f: (T) -> T) { value = f(value) }
}
internal data class TopicUi(val conversationId: String?)
internal enum class SteerState { Joined, Withdrawn }
internal data class SteerNote(val id: String, val words: String, val state: SteerState,
    val interrupted: String? = null, val finished: String? = null)
internal sealed interface ExchangeStatus {
    object Working : ExchangeStatus
    data class Done(val outcome: String, val note: String?) : ExchangeStatus
    object Failed : ExchangeStatus
    object Cancelled : ExchangeStatus
}
internal data class SharedFile(val name: String, val size: Long, val savedAs: String, val uri: String)
internal data class Exchange(val goal: String, val steps: List<String> = emptyList(),
    val status: ExchangeStatus = ExchangeStatus.Done("", null), val live: Boolean = false,
    val runId: String? = null, val steers: List<SteerNote> = emptyList(),
    val files: List<SharedFile> = emptyList(), val draft: String? = null)
