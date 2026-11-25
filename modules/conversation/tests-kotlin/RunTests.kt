@file:OptIn(ExperimentalJsExport::class)

import com.wangzan101.mika.chat.ui.*

@JsExport
fun runNavigationTests(): String {
    // First test: the owner sends in A, reads B, then returns to A's exact second message.
    val nav = createNavigation()
    nav.selectTopic("A")
    nav.selectTopic("B")
    check(nav.openResult("A", "a-late", arrayOf("first", "a-late")) == null)
    check(nav.openMessage("B", "b", arrayOf("b")) == "u0")
    nav.selectTopic("A")
    check(nav.openMessage("A", "a-late", arrayOf("first", "a-late")) == "u1")
    val serial = nav.jumpSerial().toLong()
    check(nav.openMessage("A", "a-late", arrayOf("first", "a-late")) == "u1")
    check(nav.jumpSerial().toLong() == serial + 1)
    check(nav.openResult("A", "a-late", arrayOf("first", "a-late")) == "r1")
    check(nav.openMessage("A", "unknown", arrayOf("first")) == null)
    check(nav.openMessage("A", "first", arrayOf("first", "first")) == null)
    check(createNavigation().openMessage("A", "first", arrayOf("first")) == null)
    val original = OriginalNavigationTests()
    original.openingAtAMessageKeepsTheTargetForTheChatPage()
    original.targetKeysPointAtTheRenderedRow()
    original.withdrawnSteerFallsBackToTheTurnStart()
    // A stale ack must not consume a newer jump to the same target.
    val ops = OriginalJumpOps()
    ops.openConversationAt("A", ChatTarget.Message(0, null))
    val first = ops.jump.value!!
    ops.openConversationAt("A", ChatTarget.Message(0, null))
    ops.consumeJump(first)
    check(ops.jump.value!!.serial > first.serial)
    return "PASS owner A->B / A-late hidden / reopen A.u1 / result r1 / repeat / wrong-or-duplicate rejected / unmounted isolated / stale ack; original Kotlin tests=3"
}
