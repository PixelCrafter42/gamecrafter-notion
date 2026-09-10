import { site } from './site.config';

import QuietHome from './themes/quiet-publication/Home.astro';
import QuietBaseLayout from './themes/quiet-publication/BaseLayout.astro';
import QuietPostCard from './themes/quiet-publication/PostCard.astro';
import QuietArchive from './themes/quiet-publication/Archive.astro';
import QuietArticle from './themes/quiet-publication/Article.astro';
import QuietContentPage from './themes/quiet-publication/ContentPage.astro';
import QuietNotFound from './themes/quiet-publication/NotFound.astro';
import QuietProjects from './themes/quiet-publication/Projects.astro';
import QuietProject from './themes/quiet-publication/Project.astro';
import QuietThoughtStream from './themes/quiet-publication/ThoughtStream.astro';
import QuietThought from './themes/quiet-publication/Thought.astro';

import NavfolioHome from './themes/navfolio/Home.astro';
import NavfolioBaseLayout from './themes/navfolio/BaseLayout.astro';
import NavfolioPostCard from './themes/navfolio/PostCard.astro';
import NavfolioArchive from './themes/navfolio/Archive.astro';
import NavfolioArticle from './themes/navfolio/Article.astro';
import NavfolioContentPage from './themes/navfolio/ContentPage.astro';
import NavfolioNotFound from './themes/navfolio/NotFound.astro';
import NavfolioProjects from './themes/navfolio/Projects.astro';
import NavfolioProject from './themes/navfolio/Project.astro';
import NavfolioThoughtStream from './themes/navfolio/ThoughtStream.astro';
import NavfolioThought from './themes/navfolio/Thought.astro';

const quiet = site.themeId === 'quiet-publication';

export const Home = quiet ? QuietHome : NavfolioHome;
export const BaseLayout = quiet ? QuietBaseLayout : NavfolioBaseLayout;
export const PostCard = quiet ? QuietPostCard : NavfolioPostCard;
export const Archive = quiet ? QuietArchive : NavfolioArchive;
export const Article = quiet ? QuietArticle : NavfolioArticle;
export const ContentPage = quiet ? QuietContentPage : NavfolioContentPage;
export const NotFound = quiet ? QuietNotFound : NavfolioNotFound;
export const Projects = quiet ? QuietProjects : NavfolioProjects;
export const Project = quiet ? QuietProject : NavfolioProject;
export const ThoughtStream = quiet ? QuietThoughtStream : NavfolioThoughtStream;
export const Thought = quiet ? QuietThought : NavfolioThought;
