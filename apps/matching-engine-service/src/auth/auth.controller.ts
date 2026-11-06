import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { InternalKeyGuard } from './guards/internal-key.guard';
import { AuthenticatedUser } from './strategies/jwt.strategy';

@ApiTags('auth')
@Controller('auth')
@UseGuards(RateLimitGuard)
@RateLimit('AUTH')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('PUBLIC')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken, dto.attempt);
  }

  @Post('end-session')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit('PUBLIC')
  endSession(@Body() dto: RefreshDto) {
    return this.auth.endSessionOf(dto.refreshToken);
  }

  @Post('ws-ticket')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @RateLimit('PUBLIC')
  @UseGuards(JwtAuthGuard)
  wsTicket(@Request() req: { user: AuthenticatedUser }) {
    return this.auth.wsTicket(req.user.userId, req.user.expiresAt, req.user.sessionId);
  }

  @Get('admins/:id')
  @ApiExcludeEndpoint()
  @RateLimit('PUBLIC')
  @UseGuards(InternalKeyGuard)
  async admin(@Param('id', ParseUUIDPipe) id: string) {
    return { admin: await this.auth.isAdmin(id) };
  }

  @Post('logout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit('PUBLIC')
  @UseGuards(JwtAuthGuard)
  logout(@Request() req: { user: AuthenticatedUser }) {
    return this.auth.logout(req.user.userId, req.user.sessionId);
  }
}
