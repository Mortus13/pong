import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
type UserRole = 'player' | 'spectator';

@WebSocketGateway({ cors: true })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private readonly CANVAS_WIDTH = 800;
  private readonly CANVAS_HEIGHT = 600;
  private readonly PADDLE_WIDTH = 15;
  private readonly PADDLE_HEIGHT = 100;
  private readonly BALL_RADIUS = 10;
  private readonly BASE_SPEED = 5;
  private readonly SPEED_INCREASE = 1;
  

  private gameState = {
    ball: {
      x: this.CANVAS_WIDTH / 2,
      y: this.CANVAS_HEIGHT / 2,
      dx: this.BASE_SPEED,
      dy: 0,
      speed: this.BASE_SPEED,
    },
    paddles: {
      left: this.CANVAS_HEIGHT / 2 - this.PADDLE_HEIGHT / 2,
      right: this.CANVAS_HEIGHT / 2 - this.PADDLE_HEIGHT / 2,
    },
    score: { player: 0, opponent: 0 },
  };

  private gameInterval: NodeJS.Timeout | null = null;
  private players: {
    client: Socket;
    side: 'left' | 'right' | null;
    role: UserRole;
  }[] = [];

  handleConnection(client: Socket) {
    if (this.players.length >= 2) {
      // Третий и далее - зрители
      this.players.push({ client, side: null, role: 'spectator' });
      client.emit('roleAssigned', 'spectator');
      return;
    }
  
    // Первые два - игроки
    const side = this.players.length === 0 ? 'left' : 'right';
    this.players.push({ client, side, role: 'player' });
    client.emit('roleAssigned', 'player');
    client.emit('assignSide', side);
  
    if (this.players.filter(p => p.role === 'player').length === 2) {
      this.startGame();
    }
  }

  handleDisconnect(client: Socket) {
    const playerIndex = this.players.findIndex(p => p.client === client);
    if (playerIndex !== -1) {
      const disconnectedPlayer = this.players[playerIndex];
      this.players.splice(playerIndex, 1);
      
      // Если отключился игрок, ищем зрителя на замену
      if (disconnectedPlayer.role === 'player') {
        const spectator = this.players.find(p => p.role === 'spectator');
        if (spectator) {
          spectator.role = 'player';
          spectator.side = disconnectedPlayer.side;
          spectator.client.emit('roleAssigned', 'player');
          spectator.client.emit('assignSide', disconnectedPlayer.side);
        }
      }
    }
  }
  private getNormalizedGameState() {
    return {
      ball: {
        x: (this.gameState.ball.x / this.CANVAS_WIDTH) * 100,
        y: (this.gameState.ball.y / this.CANVAS_HEIGHT) * 100,
      },
      paddles: {
        left: (this.gameState.paddles.left / this.CANVAS_HEIGHT) * 100,
        right: (this.gameState.paddles.right / this.CANVAS_HEIGHT) * 100,
      },
      score: this.gameState.score,
    };
  }
  private startGame() {
    if (this.gameInterval) clearInterval(this.gameInterval);
    
    this.gameInterval = setInterval(() => {
      this.updateGameState();
      const gameData = this.getNormalizedGameState();
      // Отправляем состояние всем подключенным
      this.players.forEach(player => {
        player.client.emit('gameState', {
          ...gameData,
          yourRole: player.role,
          yourSide: player.side
        });
      });
    }, 16);
  }

  updateGameState() {
    // Движение шарика с текущей скоростью
    this.gameState.ball.x += this.gameState.ball.dx;
    this.gameState.ball.y += this.gameState.ball.dy;

    // Отскок от верхней/нижней границы
    if (
      this.gameState.ball.y <= this.BALL_RADIUS ||
      this.gameState.ball.y >= this.CANVAS_HEIGHT - this.BALL_RADIUS
    ) {
      this.gameState.ball.dy *= -1;
    }

    // Проверка столкновений с ракетками
    const hitLeft = this.checkPaddleCollision('left');
    const hitRight = this.checkPaddleCollision('right');

    if (hitLeft || hitRight) {
      this.handlePaddleHit(hitLeft ? 'left' : 'right');
    }

    // Проверка голов
    if (this.gameState.ball.x <= 0) {
      this.resetBall('right');
      this.gameState.score.opponent++;
    } else if (this.gameState.ball.x >= this.CANVAS_WIDTH) {
      this.resetBall('left');
      this.gameState.score.player++;
    }
  }

  private checkPaddleCollision(side: 'left' | 'right'): boolean {
    const paddleX =
      side === 'left' ? 20 : this.CANVAS_WIDTH - 20 - this.PADDLE_WIDTH;
    const paddleY = this.gameState.paddles[side];

    return (
      this.gameState.ball.x - this.BALL_RADIUS <= paddleX + this.PADDLE_WIDTH &&
      this.gameState.ball.x + this.BALL_RADIUS >= paddleX &&
      this.gameState.ball.y >= paddleY &&
      this.gameState.ball.y <= paddleY + this.PADDLE_HEIGHT
    );
  }

  private handlePaddleHit(side: 'left' | 'right') {
    // Увеличение скорости при каждом отскоке
    this.gameState.ball.speed += this.SPEED_INCREASE;

    // Расчет угла отскока
    const paddleCenter = this.gameState.paddles[side] + this.PADDLE_HEIGHT / 2;
    const relativeIntersect =
      (paddleCenter - this.gameState.ball.y) / (this.PADDLE_HEIGHT / 2);
    const bounceAngle = relativeIntersect * (Math.PI / 3); // Макс 60 градусов

    // Обновление вектора скорости
    this.gameState.ball.dx =
      Math.cos(bounceAngle) *
      this.gameState.ball.speed *
      (side === 'left' ? 1 : -1);
    this.gameState.ball.dy = -Math.sin(bounceAngle) * this.gameState.ball.speed;

    // Коррекция позиции чтобы шарик не застревал в ракетке
    this.gameState.ball.x =
      side === 'left'
        ? 20 + this.PADDLE_WIDTH + this.BALL_RADIUS
        : this.CANVAS_WIDTH - 20 - this.PADDLE_WIDTH - this.BALL_RADIUS;
  }

  private resetBall(direction: 'left' | 'right') {
    // Сброс скорости к базовой
    this.gameState.ball = {
      x: this.CANVAS_WIDTH / 2,
      y: this.CANVAS_HEIGHT / 2,
      dx: direction === 'right' ? this.BASE_SPEED : -this.BASE_SPEED,
      dy: (Math.random() - 0.5) * 2,
      speed: this.BASE_SPEED,
    };
  }

  @SubscribeMessage('paddleMove')
  handlePaddleMove(client: Socket, position: number) {
    const player = this.players.find(p => p.client === client);
    
    // Только игроки могут двигать ракетки
    if (player?.role !== 'player') return;

    if (player.side) {
      this.gameState.paddles[player.side] = (position / 100) * this.CANVAS_HEIGHT;
    }
  }
}
