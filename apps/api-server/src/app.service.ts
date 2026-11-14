import { Injectable } from '@nestjs/common'

import { PrismaService } from './prisma/prisma.service'

@Injectable()
export class AppService {
  constructor(private readonly prismaService: PrismaService) {}
  async getUsers(): Promise<any[]> {
    const users = await this.prismaService.user.findMany()
    console.log('users', users)
    return users
  }

  async saveUser(): Promise<string> {
    console.log('saveUser')
    await this.prismaService.user.create({
      data: {
        name: 'renmx',
        email: `renmx+${Date.now()}@example.com`,
        password: '123456',
      },
    })
    return 'User saved'
  }

  async saveApp(body: any): Promise<string> {
    console.log('saveApp', body)
    await this.prismaService.app.create({
      data: {
        ...body,
        name: `app-${Date.now()}`,
        userId: 'cmwbujpo00000isu4c38ki8mu',
      },
    })
    return 'App saved'
  }
  async getAppsByUserId(userId: string): Promise<any> {
    const apps = await this.prismaService.app.findMany({
      where: {
        userId,
      },
    })
    return apps
  }
}
