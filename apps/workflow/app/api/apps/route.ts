import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  // 这里可以写你的逻辑：查数据库、调外部接口、或直接返回数据
  const apps = [
    { id: 1, name: 'App A' },
    { id: 2, name: 'App B' },
  ]

  return NextResponse.json(apps)
}
