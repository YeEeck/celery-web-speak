<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, KeyRound, LockKeyhole, UserRound } from '@lucide/vue'
import { useAppStore } from '../stores/app'

const app = useAppStore()
const mode = ref<'login' | 'register'>('login')
const username = ref('')
const displayName = ref('')
const password = ref('')
const inviteCode = ref('')
const busy = ref(false)
const errorMessage = ref('')

const title = computed(() => mode.value === 'login' ? '欢迎回来' : '接受邀请')

async function submit() {
  busy.value = true
  errorMessage.value = ''
  try {
    if (mode.value === 'login') {
      await app.login(username.value, password.value)
    } else {
      await app.register(inviteCode.value, username.value, displayName.value, password.value)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '请求失败'
  } finally {
    busy.value = false
  }
}

function switchMode(next: 'login' | 'register') {
  mode.value = next
  errorMessage.value = ''
  password.value = ''
}
</script>

<template>
  <main class="auth-screen">
    <section class="auth-brand">
      <img class="brand-mark large" src="/favicon.svg" alt="" />
      <div>
        <h1>Celery Web Speak</h1>
        <p>小组语音 · 频道文字 · 即时在线</p>
      </div>
    </section>

    <section class="auth-panel" aria-labelledby="auth-title">
      <div class="auth-tabs" role="tablist">
        <button :class="{ active: mode === 'login' }" role="tab" @click="switchMode('login')">登录</button>
        <button :class="{ active: mode === 'register' }" role="tab" @click="switchMode('register')">邀请码注册</button>
      </div>
      <header>
        <h2 id="auth-title">{{ title }}</h2>
        <p>{{ mode === 'login' ? '使用你的账号进入频道' : '创建一个仅属于此服务器的账号' }}</p>
      </header>

      <form :key="mode" class="motion-content-in" @submit.prevent="submit">
        <label v-if="mode === 'register'">
          <span>邀请码</span>
          <span class="input-wrap"><KeyRound :size="18" /><input v-model.trim="inviteCode" required autocomplete="one-time-code" /></span>
        </label>
        <label>
          <span>登录名</span>
          <span class="input-wrap"><UserRound :size="18" /><input v-model.trim="username" required minlength="3" maxlength="32" autocomplete="username" /></span>
        </label>
        <label v-if="mode === 'register'">
          <span>显示名称</span>
          <span class="input-wrap"><UserRound :size="18" /><input v-model.trim="displayName" required maxlength="32" autocomplete="nickname" /></span>
        </label>
        <label>
          <span>密码</span>
          <span class="input-wrap"><LockKeyhole :size="18" /><input v-model="password" type="password" required minlength="10" maxlength="128" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" /></span>
        </label>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        <button class="primary-button submit-button" :disabled="busy">
          <span>{{ busy ? '请稍候' : mode === 'login' ? '登录' : '创建账号' }}</span>
          <ArrowRight v-if="!busy" :size="18" />
        </button>
      </form>
    </section>
  </main>
</template>
