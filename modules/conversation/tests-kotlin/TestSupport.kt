package com.wangzan101.mika.chat.ui

// Test-only shims; the copied synchronous assertions need neither JUnit nor a coroutine scheduler.
internal annotation class Test
internal fun assertEquals(expected: Any?, actual: Any?) { check(expected == actual) { "expected=$expected actual=$actual" } }
internal fun assertNull(actual: Any?) { check(actual == null) { "expected null, was $actual" } }
internal fun assertTrue(value: Boolean) { check(value) }
internal fun runTest(block: () -> Unit) = block()
