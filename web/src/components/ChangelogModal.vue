<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { X } from '@lucide/vue'
import { request } from '../api'
import type { ChangelogEntry, ChangelogResponse } from '../types'

defineEmits<{ close: [] }>()

const entries = ref<ChangelogEntry[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref('')
const PAGE_SIZE = 5

const hasMore = () => entries.value.length < total.value

async function loadPage(targetPage: number) {
  loading.value = true
  error.value = ''
  try {
    const data = await request<ChangelogResponse>(`/api/changelog?page=${targetPage}&size=${PAGE_SIZE}`)
    if (targetPage === 1) {
      entries.value = data.entries
    } else {
      entries.value = [...entries.value, ...data.entries]
    }
    total.value = data.total
    page.value = targetPage
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载更新日志失败'
  } finally {
    loading.value = false
  }
}

function loadMore() {
  if (!loading.value && hasMore()) {
    void loadPage(page.value + 1)
  }
}

onMounted(() => void loadPage(1))
</script>

<template>
  <div class="modal-backdrop changelog-backdrop" @mousedown.self="$emit('close')">
    <section class="changelog-panel" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
      <header class="changelog-header">
        <h2 id="changelog-title">更新日志</h2>
        <button class="icon-button" title="关闭" @click="$emit('close')"><X :size="21" /></button>
      </header>
      <div class="changelog-scroll">
        <p v-if="error" class="changelog-error">{{ error }}</p>
        <template v-else>
          <article v-for="entry in entries" :key="entry.version" class="changelog-card">
            <header class="changelog-card-header">
              <strong>v{{ entry.version }}</strong>
              <time>{{ entry.date }}</time>
            </header>
            <ul class="changelog-changes">
              <li v-for="(change, index) in entry.changes" :key="index">{{ change }}</li>
            </ul>
          </article>
          <div class="changelog-footer">
            <button v-if="hasMore()" class="secondary-button changelog-load-more" :disabled="loading" @click="loadMore">
              {{ loading ? '加载中…' : '加载更多' }}
            </button>
            <p v-else-if="entries.length > 0" class="changelog-end">没有更多了</p>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
