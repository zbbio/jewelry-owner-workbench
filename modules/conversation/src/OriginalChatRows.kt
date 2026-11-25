// Extracted from Mika by wangzan101 (Apache-2.0), commit e8479330f7284dd0031649636e18e197d6633ece.
// K1 change: selected lines compiled with host-projection types, not Mika Android runtime.
package com.wangzan101.mika.chat.ui

/** 目标消息在 [chatItemKeys] 里的 key;轮次或消息已经不在了时返回 null。 */
internal fun chatTargetKey(exchanges: List<Exchange>, target: ChatTarget): String? {
    if (target is ChatTarget.Call) return callStartKey(target.callId)
    val turn = target.turnIndex
    val ex = exchanges.getOrNull(turn) ?: return null
    return when (target) {
        is ChatTarget.Message -> {
            val note = target.steerIndex?.let { visibleSteer(ex, it) }
            val showSteps = ex.status.isActive() && !(ex.status == ExchangeStatus.Working && !ex.draft.isNullOrBlank())
            // 插话在工作时是步骤里的一步(无独立行),收成小字后(结束/写总结)才有独立行可跳
            if (target.steerIndex != null && note != null && !showSteps) "m$turn-${note.id}" else turnStartKey(turn, ex)
        }
        is ChatTarget.Reply -> turnStartKey(turn, ex)
        is ChatTarget.Files -> if (ex.files.isNotEmpty()) "f$turn" else turnStartKey(turn, ex)
        is ChatTarget.Status -> "r$turn"
        is ChatTarget.Call -> callStartKey(target.callId)
    }
}

/** 撤回的插话不在聊天页里显示,按位置找时要跳过。 */
private fun visibleSteer(ex: Exchange, index: Int): SteerNote? =
    ex.steers.filterNot { it.state == SteerState.Withdrawn }.getOrNull(index)

/** 这一轮的开头:有用户气泡就跳到气泡,否则退回结果卡。 */
private fun turnStartKey(turnIndex: Int, ex: Exchange): String =
    if (ex.goal.isNotEmpty()) "u$turnIndex" else "r$turnIndex"

private val ChatTarget.turnIndex: Int
    get() = when (this) {
        is ChatTarget.Message -> this.turnIndex
        is ChatTarget.Reply -> this.turnIndex
        is ChatTarget.Files -> this.turnIndex
        is ChatTarget.Status -> this.turnIndex
        is ChatTarget.Call -> -1
    }

internal fun callStartKey(callId: String) = "call-$callId"

internal fun ExchangeStatus.isActive() =
    this !is ExchangeStatus.Done && this !is ExchangeStatus.Failed && this !is ExchangeStatus.Cancelled
