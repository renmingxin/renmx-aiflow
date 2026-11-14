import { Body, Controller, Get, Post } from '@nestjs/common'

import { AppService } from './app.service.js'

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('/users')
  getUsers() {
    return this.appService.getUsers()
  }

  @Post('/save-user')
  saveUser() {
    return this.appService.saveUser()
  }

  @Post('/save-app')
  saveApp(@Body() body: any) {
    return this.appService.saveApp(body)
  }
  @Get('/get-apps')
  getAppsByUserId(@Body() body: any) {
    return this.appService.getAppsByUserId(body.userId)
  }
}
