import type { OperationSoundEvent } from './patterns'

export interface CustomSoundRecord {
  event: OperationSoundEvent
  blob: Blob
  name: string
  size: number
  mime: string
  addedAt: number
}

export interface SoundPreferenceAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export interface CustomSoundStorageAdapter {
  get(event: OperationSoundEvent): Promise<CustomSoundRecord | null>
  put(record: CustomSoundRecord): Promise<void>
  remove(event: OperationSoundEvent): Promise<void>
}

export class BrowserSoundPreferenceAdapter implements SoundPreferenceAdapter {
  constructor(private readonly storage: Storage) {}

  get(key: string) {
    return this.storage.getItem(key)
  }

  set(key: string, value: string) {
    this.storage.setItem(key, value)
  }

  remove(key: string) {
    this.storage.removeItem(key)
  }
}

const DB_NAME = 'cws.sounds'
const DB_VERSION = 1
const STORE_NAME = 'customSounds'

export class IndexedDBCustomSoundStorageAdapter implements CustomSoundStorageAdapter {
  constructor(private readonly factory: IDBFactory) {}

  async get(event: OperationSoundEvent): Promise<CustomSoundRecord | null> {
    const db = await this.open()
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly')
        const request = transaction.objectStore(STORE_NAME).get(event)
        request.onsuccess = () => resolve((request.result as CustomSoundRecord | undefined) ?? null)
        request.onerror = () => reject(request.error ?? new Error('读取自定义音效失败'))
        transaction.onabort = () => reject(transaction.error ?? new Error('读取自定义音效事务已中止'))
      })
    } finally {
      db.close()
    }
  }

  async put(record: CustomSoundRecord): Promise<void> {
    const db = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).put(record)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('保存自定义音效失败'))
        transaction.onabort = () => reject(transaction.error ?? new Error('保存自定义音效事务已中止'))
      })
    } finally {
      db.close()
    }
  }

  async remove(event: OperationSoundEvent): Promise<void> {
    const db = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).delete(event)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('删除自定义音效失败'))
        transaction.onabort = () => reject(transaction.error ?? new Error('删除自定义音效事务已中止'))
      })
    } finally {
      db.close()
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'event' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('打开自定义音效存储失败'))
      request.onblocked = () => reject(new Error('自定义音效存储正被其他页面占用'))
    })
  }
}
