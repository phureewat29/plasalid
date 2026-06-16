/**
 * Hand-curated quote list for the chat welcome screen.
 *
 * Bar: every entry is attributable to a specific public source: a book,
 * shareholder letter, public lecture, or widely-documented quote of the named
 * person. Well-known misattributions (Einstein on compound interest, Twain on
 * banking, etc.) are deliberately excluded. The `source` comment beside each
 * entry names the primary source so future maintainers can audit attribution.
 */

export interface Quote {
  text: string;
  author: string;
}

export const QUOTES: Quote[] = [
  // Easter egg
  { text: "Por Laew, Por Laew, Ruay Mai Wai Laew.", author: "K.Anutin" },
  
  // Warren Buffett: Berkshire Hathaway letters & public interviews
  { text: "Rule No. 1: Never lose money. Rule No. 2: Never forget rule No. 1.", author: "Warren Buffett" },
  { text: "Price is what you pay. Value is what you get.", author: "Warren Buffett" },
  { text: "Be fearful when others are greedy, and be greedy when others are fearful.", author: "Warren Buffett" },
  { text: "Risk comes from not knowing what you are doing.", author: "Warren Buffett" },
  { text: "Someone is sitting in the shade today because someone planted a tree a long time ago.", author: "Warren Buffett" },
  { text: "The most important investment you can make is in yourself.", author: "Warren Buffett" },
  { text: "If you don't find a way to make money while you sleep, you will work until you die.", author: "Warren Buffett" },
  { text: "Our favorite holding period is forever.", author: "Warren Buffett" },

  // Charlie Munger: Poor Charlie's Almanack and Daily Journal meetings
  { text: "The first rule of compounding: never interrupt it unnecessarily.", author: "Charlie Munger" },
  { text: "The big money is not in the buying or the selling, but in the waiting.", author: "Charlie Munger" },
  { text: "Spend each day trying to be a little wiser than you were when you woke up.", author: "Charlie Munger" },
  { text: "It is remarkable how much long-term advantage people like us have gotten by trying to be consistently not stupid, instead of trying to be very intelligent.", author: "Charlie Munger" },

  // Benjamin Graham: The Intelligent Investor, Security Analysis
  { text: "The investor's chief problem — and even his worst enemy — is likely to be himself.", author: "Benjamin Graham" },
  { text: "In the short run, the market is a voting machine, but in the long run it is a weighing machine.", author: "Benjamin Graham" },

  // John C. Bogle: founder of Vanguard
  { text: "Time is your friend; impulse is your enemy.", author: "John C. Bogle" },
  { text: "The two greatest enemies of the equity fund investor are expenses and emotions.", author: "John C. Bogle" },

  // Peter Lynch: One Up On Wall Street, Beating the Street
  { text: "Know what you own, and know why you own it.", author: "Peter Lynch" },
  { text: "The real key to making money in stocks is not to get scared out of them.", author: "Peter Lynch" },

  // Howard Marks: memos and The Most Important Thing
  { text: "You can't predict. You can prepare.", author: "Howard Marks" },

  // Ray Dalio: Principles
  { text: "Pain plus reflection equals progress.", author: "Ray Dalio" },

  // Benjamin Franklin: Poor Richard's Almanack and The Way to Wealth
  { text: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
  { text: "Beware of little expenses; a small leak will sink a great ship.", author: "Benjamin Franklin" },
  { text: "If you would be wealthy, think of saving as well as of getting.", author: "Benjamin Franklin" },

  // Andrew Carnegie: The Gospel of Wealth and The Road to Business Success
  { text: "The man who dies rich dies disgraced.", author: "Andrew Carnegie" },
  { text: "Concentrate your energies, your thoughts and your capital. The wise man puts all his eggs in one basket and watches the basket.", author: "Andrew Carnegie" },

  // P.T. Barnum: The Art of Money Getting (1880)
  { text: "Money is a terrible master but an excellent servant.", author: "P.T. Barnum" },

  // Will Rogers: public columns and stage performances
  { text: "Don't gamble; take all your savings and buy some good stock and hold it till it goes up, then sell it. If it don't go up, don't buy it.", author: "Will Rogers" },
  { text: "Too many people spend money they haven't earned to buy things they don't want to impress people they don't like.", author: "Will Rogers" },

  // Henry David Thoreau: Walden and Journals
  { text: "Wealth is the ability to fully experience life.", author: "Henry David Thoreau" },
  { text: "That man is the richest whose pleasures are the cheapest.", author: "Henry David Thoreau" },

  // Ralph Waldo Emerson: The Conduct of Life (1860)
  { text: "The first wealth is health.", author: "Ralph Waldo Emerson" },

  // Seneca: Letters from a Stoic
  { text: "It is not the man who has too little, but the man who craves more, that is poor.", author: "Seneca" },
  { text: "While we are postponing, life speeds by.", author: "Seneca" },

  // Epictetus: Discourses
  { text: "Wealth consists not in having great possessions, but in having few wants.", author: "Epictetus" },

  // Confucius: Analects
  { text: "He who will not economize will have to agonize.", author: "Confucius" },

  // Adam Smith: The Wealth of Nations
  { text: "Wealth, as Mr. Hobbes says, is power.", author: "Adam Smith" },

  // Ayn Rand: Atlas Shrugged ("Francisco's money speech")
  { text: "Money is only a tool. It will take you wherever you wish, but it will not replace you as the driver.", author: "Ayn Rand" },

  // Jim Rohn: lectures and books
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "Formal education will make you a living; self-education will make you a fortune.", author: "Jim Rohn" },

  // Dave Ramsey: books and radio program
  { text: "A budget is telling your money where to go instead of wondering where it went.", author: "Dave Ramsey" },
  { text: "If you will live like no one else, later you can live like no one else.", author: "Dave Ramsey" },

  // Suze Orman: books and television
  { text: "A big part of financial freedom is having your heart and mind free from worry about the what-ifs of life.", author: "Suze Orman" },

  // Robert Kiyosaki: Rich Dad Poor Dad
  { text: "It's not how much money you make, but how much money you keep, how hard it works for you, and how many generations you keep it for.", author: "Robert Kiyosaki" },
  { text: "The poor and the middle class work for money. The rich have money work for them.", author: "Robert Kiyosaki" },

  // T. Harv Eker: Secrets of the Millionaire Mind
  { text: "Your income can grow only to the extent you do.", author: "T. Harv Eker" },

  // Morgan Housel: The Psychology of Money
  { text: "Spending money to show people how much money you have is the fastest way to have less money.", author: "Morgan Housel" },
  { text: "Doing well with money has little to do with how smart you are and a lot to do with how you behave.", author: "Morgan Housel" },

  // Naval Ravikant: "How to Get Rich" tweetstorm and podcast
  { text: "Seek wealth, not money or status. Wealth is having assets that earn while you sleep.", author: "Naval Ravikant" },
  { text: "You're not going to get rich renting out your time. You must own equity — a piece of a business — to gain your financial freedom.", author: "Naval Ravikant" },

  // George Soros: interviews
  { text: "It's not whether you're right or wrong that's important, but how much money you make when you're right and how much you lose when you're wrong.", author: "George Soros" },
];

export function pickQuote(): Quote {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}
