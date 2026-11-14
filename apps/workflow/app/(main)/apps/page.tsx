'use client'

import { useEffect, useState } from 'react'

import { apiFetch } from '@/lib/api'

type User = { id: string; name: string; email: string }
export default function AppsPage() {
  const [users, setUsers] = useState<any[]>([])
  useEffect(() => {
    apiFetch<User[]>('/users').then(setUsers).catch(console.error)
  }, [])
  return (
    <div className="px-12 py-6 border-2">
      {users.map(user => (
        <div key={user.id}>
          {user.id}- {user.name}
        </div>
      ))}
    </div>
  )
}
