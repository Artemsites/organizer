import './styles/main.scss';
import './modules/todos/todos.scss';

import { AppShell } from './core/app-shell';
import { TodosModule } from './modules/todos/todos-module';
import { NotesModule } from './modules/notes/notes-module';

// Инициализация каркаса приложения
const root = document.getElementById('app');
if (!root) {
  throw new Error('Корневой элемент #app не найден');
}

const app = new AppShell(root);

// Регистрация подключаемых модулей
app.registerModule(new TodosModule());
app.registerModule(new NotesModule());
