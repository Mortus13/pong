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
  private readonly TICK_RATE = 30; // Увеличено для оптимизации

  private lastUpdateTime: number = 0;

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
    score: { left: 0, right: 0 }, // Уточнены имена для сторон
  };

  private gameInterval: NodeJS.Timeout | null = null;
  private players: {
    client: Socket;
    side: 'left' | 'right' | null;
    role: UserRole;
  }[] = [];

  constructor() {
    // Обработка ошибок WebSocket
    this.server.on('error', (err) => {
      console.error('WebSocket server error:', err);
    });
  }

  private resetGame() {
    this.gameState = {
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
      score: { left: 0, right: 0 },
    };

    this.players.forEach((player) => {
      player.client.emit('gameReset');
    });
  }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    const playerCount = this.players.filter((p) => p.role === 'player').length;

    if (playerCount >= 2) {
      this.players.push({ client, side: null, role: 'spectator' });
      client.emit('roleAssigned', 'spectator');
      client.emit('gameState', {
        ...this.getNormalizedGameState(),
        serverTime: Date.now(),
      });
      return;
    }

    const leftPlayerExists = this.players.some((p) => p.side === 'left');
    const side = leftPlayerExists ? 'right' : 'left';
    this.players.push({ client, side, role: 'player' });
    client.emit('roleAssigned', 'player');
    client.emit('assignSide', side);

    if (this.players.filter((p) => p.role === 'player').length === 2) {
      this.resetGame();
      this.startGame();
    }
    console.log(`Assigned ${side} to new player`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    const playerIndex = this.players.findIndex((p) => p.client === client);
    if (playerIndex === -1) return;

    const disconnectedPlayer = this.players[playerIndex];
    this.players.splice(playerIndex, 1);

    if (disconnectedPlayer.role === 'player') {
      if (this.gameInterval) {
        clearInterval(this.gameInterval);
        this.gameInterval = null;
      }

      const spectator = this.players.find((p) => p.role === 'spectator');
      if (spectator) {
        spectator.role = 'player';
        spectator.side = disconnectedPlayer.side;
        spectator.client.emit('roleAssigned', 'player');
        spectator.client.emit('assignSide', disconnectedPlayer.side);

        if (this.players.filter((p) => p.role === 'player').length === 2) {
          this.resetGame();
          this.startGame();
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
    this.lastUpdateTime = Date.now();
    this.gameInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastUpdateTime;
      this.lastUpdateTime = now;

      this.updateGameState(delta);
      this.server.emit('gameState', {
        ...this.getNormalizedGameState(),
        serverTime: now,
      });
    }, this.TICK_RATE);
  }

  private updateGameState(delta: number) {
    this.gameState.ball.x += this.gameState.ball.dx * (delta / 16);
    this.gameState.ball.y += this.gameState.ball.dy * (delta / 16);

    if (
      this.gameState.ball.y <= this.BALL_RADIUS ||
      this.gameState.ball.y >= this.CANVAS_HEIGHT - this.BALL_RADIUS
    ) {
      this.gameState.ball.dy *= -1;
    }

    const hitLeft = this.checkPaddleCollision('left');
    const hitRight = this.checkPaddleCollision('right');

    if (hitLeft || hitRight) {
      this.handlePaddleHit(hitLeft ? 'left' : 'right');
    }

    if (this.gameState.ball.x <= 0) {
      this.gameState.score.right++;
      this.resetBall('right');
      this.server.emit('scoreUpdate', this.gameState.score);
    } else if (this.gameState.ball.x >= this.CANVAS_WIDTH) {
      this.gameState.score.left++;
      this.resetBall('left');
      this.server.emit('scoreUpdate', this.gameState.score);
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
    this.gameState.ball.speed += this.SPEED_INCREASE;

    const paddleCenter = this.gameState.paddles[side] + this.PADDLE_HEIGHT / 2;
    const relativeIntersect =
      (paddleCenter - this.gameState.ball.y) / (this.PADDLE_HEIGHT / 2);
    const bounceAngle = relativeIntersect * (Math.PI / 3);

    this.gameState.ball.dx =
      Math.cos(bounceAngle) *
      this.gameState.ball.speed *
      (side === 'left' ? 1 : -1);
    this.gameState.ball.dy = -Math.sin(bounceAngle) * this.gameState.ball.speed;

    this.gameState.ball.x =
      side === 'left'
        ? 20 + this.PADDLE_WIDTH + this.BALL_RADIUS
        : this.CANVAS_WIDTH - 20 - this.PADDLE_WIDTH - this.BALL_RADIUS;
  }

  private resetBall(direction: 'left' | 'right') {
    this.gameState.ball = {
      x: this.CANVAS_WIDTH / 2,
      y: this.CANVAS_HEIGHT / 2,
      dx: direction === 'right' ? this.BASE_SPEED : -this.BASE_SPEED,
      dy: (Math.random() - 0.5) * 2,
      speed: this.BASE_SPEED,
    };
  }

  @SubscribeMessage('paddleMove')
  handlePaddleMove(client: Socket, data: { pos: number; clientTime: number }) {
    const player = this.players.find((p) => p.client === client);
    if (!player?.side) return;

    this.gameState.paddles[player.side] = (data.pos / 100) * this.CANVAS_HEIGHT;
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket, clientTime: number) {
    client.emit('pong', clientTime);
  }
}