export interface MemoryEntry {
    user: string;
    ai: string;
    emotion: string | null;
    timestamp: number;
}

class MemorySystem {
    private memory: MemoryEntry[] = [];

    push(entry: MemoryEntry) {
        this.memory.push(entry);
        if (this.memory.length > 50) {
            this.memory.shift();
        }
    }

    getLast(count: number = 5): MemoryEntry[] {
        return this.memory.slice(-count);
    }

    getAll(): MemoryEntry[] {
        return this.memory;
    }
}

export const memoryStore = new MemorySystem();
