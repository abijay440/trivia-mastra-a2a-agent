import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
// Utility function to decode HTML entities
function decodeHtml(str) {
    if (!str)
        return str;
    return str
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&rsquo;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&hellip;/g, '...')
        .replace(/&eacute;/g, 'é');
}
// Utility function to shuffle arrays
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}
// In-memory storage (in production, use Mastra's memory system)
const gameStates = new Map();
export const startGameTool = createTool({
    id: 'start-trivia-game',
    description: 'Start a new trivia game session with daily questions',
    inputSchema: z.object({
        playerId: z.string().describe('Unique player identifier'),
        questionsCount: z.number().default(10).describe('Number of questions')
    }),
    outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        currentQuestion: z.object({
            index: z.number(),
            question: z.string(),
            options: z.array(z.string()),
            category: z.string(),
            difficulty: z.string()
        }).optional(),
        totalQuestions: z.number()
    }),
    execute: async ({ context }) => {
        const { playerId, questionsCount = 10 } = context;
        const today = new Date().toISOString().split('T')[0];
        try {
            // Fetch questions from OpenTDB
            const response = await fetch(`https://opentdb.com/api.php?amount=${questionsCount}&type=multiple`);
            const _data = await response.json();
            const data = _data;
            if (!data.results || data.results.length === 0) {
                throw new Error('Failed to fetch questions');
            }
            const questions = data.results.map((q, index) => ({
                id: `q-${index + 1}`,
                category: decodeHtml(q.category),
                difficulty: q.difficulty,
                question: decodeHtml(q.question),
                options: shuffleArray([...q.incorrect_answers.map(decodeHtml), decodeHtml(q.correct_answer)]),
                correct: decodeHtml(q.correct_answer),
                answered: false
            }));
            // Initialize or reset game state
            const gameState = {
                playerId,
                score: 0,
                currentQuestionIndex: 0,
                questions,
                streak: 0,
                hintsUsed: 0,
                skipsUsed: 0,
                lastPlayed: today
            };
            gameStates.set(playerId, gameState);
            const currentQuestion = questions[0];
            return {
                success: true,
                message: `🎯 Welcome to Daily Trivia! You have ${questionsCount} questions to answer. Good luck!`,
                currentQuestion: {
                    index: 1,
                    question: currentQuestion.question,
                    options: currentQuestion.options,
                    category: currentQuestion.category,
                    difficulty: currentQuestion.difficulty
                },
                totalQuestions: questions.length
            };
        }
        catch (error) {
            return {
                success: false,
                message: 'Failed to start game. Please try again later.',
                totalQuestions: 0
            };
        }
    }
});
export const answerQuestionTool = createTool({
    id: 'answer-trivia-question',
    description: 'Submit an answer to the current trivia question',
    inputSchema: z.object({
        playerId: z.string().describe('Unique player identifier'),
        answer: z.string().describe('Answer choice (A, B, C, D) or exact text')
    }),
    outputSchema: z.object({
        correct: z.boolean(),
        score: z.number(),
        message: z.string(),
        correctAnswer: z.string(),
        streak: z.number(),
        nextQuestion: z.object({
            index: z.number(),
            question: z.string(),
            options: z.array(z.string()),
            category: z.string(),
            difficulty: z.string()
        }).optional(),
        gameCompleted: z.boolean()
    }),
    execute: async ({ context }) => {
        const { playerId, answer } = context;
        const gameState = gameStates.get(playerId);
        if (!gameState) {
            throw new Error('No active game found. Please start a new game.');
        }
        const currentQuestion = gameState.questions[gameState.currentQuestionIndex];
        if (!currentQuestion) {
            throw new Error('No current question found.');
        }
        // Normalize answer comparison
        const normalizedUserAnswer = answer.trim().toUpperCase();
        const normalizedCorrectAnswer = currentQuestion.correct.toUpperCase();
        // Check if answer is by letter (A, B, C, D) or by text
        let isCorrect = false;
        if (/^[A-D]$/.test(normalizedUserAnswer)) {
            const optionIndex = normalizedUserAnswer.charCodeAt(0) - 65; // A=0, B=1, etc.
            const option = currentQuestion.options[optionIndex];
            isCorrect = option === currentQuestion.correct;
        }
        else {
            isCorrect = normalizedUserAnswer === normalizedCorrectAnswer;
        }
        // Update game state
        currentQuestion.answered = true;
        currentQuestion.userAnswer = answer;
        let scoreGained = 0;
        let message = '';
        if (isCorrect) {
            gameState.streak += 1;
            // Base points with difficulty multiplier
            const basePoints = 10;
            const difficultyMultiplier = {
                easy: 1,
                medium: 1.5,
                hard: 2
            }[currentQuestion.difficulty] || 1;
            // Streak bonus every 3 correct answers
            const streakBonus = gameState.streak >= 3 ? Math.floor(gameState.streak / 3) * 2 : 0;
            scoreGained = Math.round(basePoints * difficultyMultiplier) + streakBonus;
            gameState.score += scoreGained;
            message = `✅ Correct! +${scoreGained} points. `;
            if (streakBonus > 0) {
                message += `🔥 Streak bonus: +${streakBonus}! `;
            }
            message += `Current streak: ${gameState.streak}.`;
        }
        else {
            gameState.streak = 0;
            message = `❌ Incorrect. The correct answer was: ${currentQuestion.correct}`;
        }
        // Move to next question
        gameState.currentQuestionIndex += 1;
        const gameCompleted = gameState.currentQuestionIndex >= gameState.questions.length;
        let nextQuestion = undefined;
        if (!gameCompleted) {
            const nextQ = gameState.questions[gameState.currentQuestionIndex];
            nextQuestion = {
                index: gameState.currentQuestionIndex + 1,
                question: nextQ.question,
                options: nextQ.options,
                category: nextQ.category,
                difficulty: nextQ.difficulty
            };
        }
        else {
            message += `\n\n🎉 Game Completed! Final Score: ${gameState.score}/${gameState.questions.length * 10}`;
        }
        gameStates.set(playerId, gameState);
        return {
            correct: isCorrect,
            score: gameState.score,
            message,
            correctAnswer: currentQuestion.correct,
            streak: gameState.streak,
            nextQuestion,
            gameCompleted
        };
    }
});
export const getHintTool = createTool({
    id: 'get-trivia-hint',
    description: 'Get a 50/50 hint for the current question (eliminates two wrong answers)',
    inputSchema: z.object({
        playerId: z.string().describe('Unique player identifier')
    }),
    outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        remainingOptions: z.array(z.string()),
        hintsUsed: z.number(),
        scorePenalty: z.number()
    }),
    execute: async ({ context }) => {
        const { playerId } = context;
        const gameState = gameStates.get(playerId);
        if (!gameState) {
            throw new Error('No active game found.');
        }
        const currentQuestion = gameState.questions[gameState.currentQuestionIndex];
        if (!currentQuestion) {
            throw new Error('No current question found.');
        }
        if (gameState.hintsUsed >= 3) {
            return {
                success: false,
                message: 'You have used all available hints for this game.',
                remainingOptions: currentQuestion.options,
                hintsUsed: gameState.hintsUsed,
                scorePenalty: 0
            };
        }
        // 50/50 hint: keep correct answer and one wrong answer
        const wrongAnswers = currentQuestion.options.filter(opt => opt !== currentQuestion.correct);
        const randomWrongAnswer = wrongAnswers.length > 0 ? wrongAnswers[Math.floor(Math.random() * wrongAnswers.length)] : currentQuestion.correct;
        const remainingOptions = shuffleArray([currentQuestion.correct, randomWrongAnswer]);
        // Apply penalty
        const penalty = 2;
        gameState.score = Math.max(0, gameState.score - penalty);
        gameState.hintsUsed += 1;
        gameStates.set(playerId, gameState);
        return {
            success: true,
            message: `💡 Hint used! Two options eliminated. (-${penalty} points)`,
            remainingOptions,
            hintsUsed: gameState.hintsUsed,
            scorePenalty: penalty
        };
    }
});
export const skipQuestionTool = createTool({
    id: 'skip-trivia-question',
    description: 'Skip the current question and move to the next one',
    inputSchema: z.object({
        playerId: z.string().describe('Unique player identifier')
    }),
    outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        nextQuestion: z.object({
            index: z.number(),
            question: z.string(),
            options: z.array(z.string()),
            category: z.string(),
            difficulty: z.string()
        }).optional(),
        skipsUsed: z.number(),
        scorePenalty: z.number()
    }),
    execute: async ({ context }) => {
        const { playerId } = context;
        const gameState = gameStates.get(playerId);
        if (!gameState) {
            throw new Error('No active game found.');
        }
        if (gameState.skipsUsed >= 2) {
            return {
                success: false,
                message: 'You have used all available skips for this game.',
                skipsUsed: gameState.skipsUsed,
                scorePenalty: 0
            };
        }
        // Apply penalty
        const penalty = 1;
        gameState.score = Math.max(0, gameState.score - penalty);
        gameState.skipsUsed += 1;
        gameState.streak = 0;
        // Move to next question
        gameState.currentQuestionIndex += 1;
        const gameCompleted = gameState.currentQuestionIndex >= gameState.questions.length;
        let nextQuestion = undefined;
        if (!gameCompleted) {
            const nextQ = gameState.questions[gameState.currentQuestionIndex];
            nextQuestion = {
                index: gameState.currentQuestionIndex + 1,
                question: nextQ.question,
                options: nextQ.options,
                category: nextQ.category,
                difficulty: nextQ.difficulty
            };
        }
        gameStates.set(playerId, gameState);
        const message = gameCompleted
            ? `⏭️ Question skipped. Game completed! Final score: ${gameState.score}`
            : `⏭️ Question skipped. (-${penalty} points)`;
        return {
            success: true,
            message,
            nextQuestion,
            skipsUsed: gameState.skipsUsed,
            scorePenalty: penalty
        };
    }
});
export const getLeaderboardTool = createTool({
    id: 'get-trivia-leaderboard',
    description: 'Get the current leaderboard with top players',
    inputSchema: z.object({}),
    outputSchema: z.object({
        leaderboard: z.array(z.object({
            playerId: z.string(),
            score: z.number(),
            streak: z.number(),
            questionsAnswered: z.number()
        })),
        totalPlayers: z.number()
    }),
    execute: async ({ context }) => {
        // Convert game states to leaderboard entries
        const entries = Array.from(gameStates.entries())
            .map(([playerId, state]) => ({
            playerId,
            score: state.score,
            streak: state.streak,
            questionsAnswered: state.questions.filter(q => q.answered).length
        }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10); // Top 10
        return {
            leaderboard: entries,
            totalPlayers: gameStates.size
        };
    }
});
export const getGameStatsTool = createTool({
    id: 'get-game-stats',
    description: 'Get current game statistics for a player',
    inputSchema: z.object({
        playerId: z.string().describe('Unique player identifier')
    }),
    outputSchema: z.object({
        playerId: z.string(),
        score: z.number(),
        currentQuestion: z.number(),
        totalQuestions: z.number(),
        streak: z.number(),
        hintsUsed: z.number(),
        skipsUsed: z.number(),
        correctAnswers: z.number(),
        accuracy: z.number()
    }),
    execute: async ({ context }) => {
        const { playerId } = context;
        const gameState = gameStates.get(playerId);
        if (!gameState) {
            throw new Error('No active game found.');
        }
        const answeredQuestions = gameState.questions.filter(q => q.answered);
        const correctAnswers = answeredQuestions.filter(q => {
            if (!q.userAnswer)
                return false;
            const ua = q.userAnswer.toUpperCase();
            if (ua.length === 1 && /^[A-D]$/.test(ua)) {
                const idx = ua.charCodeAt(0) - 65;
                const opt = gameState.questions[0].options[idx];
                return opt === q.correct;
            }
            return ua === q.correct.toUpperCase();
        }).length;
        const accuracy = answeredQuestions.length > 0 ? (correctAnswers / answeredQuestions.length) * 100 : 0;
        return {
            playerId,
            score: gameState.score,
            currentQuestion: gameState.currentQuestionIndex + 1,
            totalQuestions: gameState.questions.length,
            streak: gameState.streak,
            hintsUsed: gameState.hintsUsed,
            skipsUsed: gameState.skipsUsed,
            correctAnswers,
            accuracy: Math.round(accuracy)
        };
    }
});
