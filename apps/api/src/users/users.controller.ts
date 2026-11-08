import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { createSignerSchema, CreateSignerInput, createUserSchema, CreateUserInput, updateUserSchema } from '@ruliba/shared';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../auth/decorators';
import { Meta, RequestMeta } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles('ADMIN', 'AUDITOR')
  @Get()
  list(@Query('q') q?: string) {
    return this.users.list(q?.slice(0, 100));
  }

  @Get('directory')
  directory(@Query('q') q?: string, @Query('signers') signers?: string) {
    return this.users.directory(q?.slice(0, 100), signers === '1' || signers === 'true');
  }

  /** Senders add a colleague without an account as an internal signer: Signer role, waits for activation. */
  @Roles('ADMIN', 'SENDER')
  @Post('signers')
  createSigner(@Body(new ZodPipe(createSignerSchema)) body: CreateSignerInput, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.users.createSigner(body, by, meta);
  }

  @Roles('ADMIN')
  @Post()
  create(@Body(new ZodPipe(createUserSchema)) body: CreateUserInput, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.users.create(body, by, meta);
  }

  @Roles('ADMIN')
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>,
    @CurrentUser() by: AuthUser,
    @Meta() meta: RequestMeta,
  ) {
    return this.users.update(id, body, by, meta);
  }

  @Roles('ADMIN')
  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.users.resetPassword(id, by, meta);
  }

  @Roles('ADMIN')
  @Post(':id/resend-activation')
  @HttpCode(200)
  resendActivation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.users.resendActivation(id, by, meta);
  }

  @Roles('ADMIN')
  @Post(':id/reset-mfa')
  @HttpCode(200)
  resetMfa(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() by: AuthUser, @Meta() meta: RequestMeta) {
    return this.users.resetMfa(id, by, meta);
  }
}
